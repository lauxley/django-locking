# -*- coding: utf-8 -*-
from datetime import datetime

from django.db import models
from django.db.models.expressions import ExpressionNode
from django.contrib.auth import models as auth
from django.conf import settings
from locking import logger
import managers

class ObjectLockedError(IOError):
    pass

class LockableModelFieldsMixin(models.Model):
    """
    Mixin that holds all fields of final class LockableModel.
    """
    class Meta:
        abstract = True
        
    locked_at = models.DateTimeField(db_column=getattr(settings, "LOCKED_AT_DB_FIELD_NAME", "checked_at"), 
        null=True,
        editable=False)
    locked_by = models.ForeignKey(auth.User, 
        db_column=getattr(settings, "LOCKED_BY_DB_FIELD_NAME", "checked_by"),
        related_name="working_on_%(class)s",
        null=True,
        editable=False)
    hard_lock = models.BooleanField(db_column='hard_lock', default=False, editable=False)
    modified_at = models.DateTimeField(
        auto_now=True,
        editable=False,
        db_column=getattr(settings, "MODIFIED_AT_DB_FIELD_NAME", "modified_at")
    )

class LockableModelMethodsMixin(models.Model):
    """
    Mixin that holds all methods of final class LockableModel.

    Inherit directly from this class (instead of LockableModel) if you want
    to declare your locking fields with custom options (on_delete, blank, etc.).
    """
    class Meta:
        abstract = True
    
    @property
    def lock_type(self):
        """ Returns the type of lock that is currently active. Either
        ``hard``, ``soft`` or ``None``. Read-only. """
        if self.is_locked:
            if self.hard_lock:
                return "hard"
            else:
                return "soft"
        else:
            return None

    @property
    def is_locked(self):
        """
        A read-only property that returns True or False.
        Works by calculating if the last lock (self.locked_at) has timed out or not.
        """
        if isinstance(self.locked_at, datetime):
            if (datetime.today() - self.locked_at).seconds < settings.LOCKING['time_until_expiration']:
                return True
            else:
                return False
        return False
    
    @property
    def lock_seconds_remaining(self):
        """
        A read-only property that returns the amount of seconds remaining before
        any existing lock times out.
        
        May or may not return a negative number if the object is currently unlocked.
        That number represents the amount of seconds since the last lock expired.
        
        If you want to extend a lock beyond its current expiry date, initiate a new
        lock using the ``lock_for`` method.
        """
        return settings.LOCKING['time_until_expiration'] - (datetime.today() - self.locked_at).seconds
    
    def lock_for(self, user, hard_lock=False):
        """
        Together with ``unlock_for`` this is probably the most important method 
        on this model. If applicable to your use-case, you should lock for a specific 
        user; that way, we can throw an exception when another user tries to unlock
        an object they haven't locked themselves.
        
        When using soft locks (the default), any process can still use the save method
        on this object. If you set ``hard_lock=True``, trying to save an object
        without first unlocking will raise an ``ObjectLockedError``.
        
        Don't use hard locks unless you really need them. See :doc:`design`.
        """
        logger.info(u"Attempting to initiate a lock for user `%s`" % user)

        if not isinstance(user, auth.User):
            raise ValueError("You should pass a valid auth.User to lock_for.")
        
        if self.lock_applies_to(user):
            raise ObjectLockedError("This object is already locked by another user. \
                May not override, except through the `unlock` method.")
        else:
            update(
                self,
                locked_at=datetime.today(),
                locked_by=user,
                hard_lock=hard_lock,
            )
            logger.info(u"Initiated a %s lock for `%s` at %s" % (self.lock_type, self.locked_by, self.locked_at))     

    def unlock(self):
        """
        This method serves solely to allow the application itself or admin users
        to do manual lock overrides, even if they haven't initiated these
        locks themselves. Otherwise, use ``unlock_for``.
        """
        update(
            self,
            locked_at=None,
            locked_by=None,
            hard_lock=False,
        )
        logger.info(u"Disengaged lock on `%s`" % self)
    
    def unlock_for(self, user):
        """
        See ``lock_for``. If the lock was initiated for a specific user, 
        unlocking will fail unless that same user requested the unlocking. 
        Manual overrides should use the ``unlock`` method instead.
        
        Will raise a ObjectLockedError exception when the current user isn't authorized to
        unlock the object.
        """
        logger.info(u"Attempting to open up a lock on `%s` by user `%s`" % (self, user))
    
        # refactor: should raise exceptions instead
        if self.is_locked_by(user):
            self.unlock()
        else:
            raise ObjectLockedError("Trying to unlock for another user than the one who initiated the currently active lock. This is not allowed. You may want to try a manual override through the `unlock` method instead.")
    
    def lock_applies_to(self, user):
        """
        A lock does not apply to the user who initiated the lock. Thus, 
        ``lock_applies_to`` is used to ascertain whether a user is allowed
        to edit a locked object.
        """
        logger.info(u"Checking if the lock on `%s` applies to user `%s`" % (self, user))
        # a lock does not apply to the person who initiated the lock
        if self.is_locked and self.locked_by != user:
            logger.info(u"Lock applies.")
            return True
        else:
            logger.info(u"Lock does not apply.")
            return False
    
    def is_locked_by(self, user):
        """
        Returns True or False. Can be used to test whether this object is locked by
        a certain user. The ``lock_applies_to`` method and the ``is_locked`` and 
        ``locked_by`` attributes are probably more useful for most intents and
        purposes.
        """
        return user == self.locked_by
    
    def save(self, *vargs, **kwargs):
        if self.lock_type == 'hard':
            raise ObjectLockedError("""There is currently a hard lock in place. You may not save.
            If you're requesting this save in order to unlock this object for the user who
            initiated the lock, make sure to call `unlock_for` first, with the user as
            the argument.""")
        
        super(LockableModelMethodsMixin, self).save(*vargs, **kwargs)



class LockableModel(LockableModelFieldsMixin, LockableModelMethodsMixin):
    """ LockableModel comes with three managers: ``objects``, ``locked`` and 
    ``unlocked``. They do what you'd expect them to. """

    objects = managers.Manager()
    locked = managers.LockedManager()
    unlocked = managers.UnlockedManager()

    class Meta:
        abstract = True
    

def update(obj, using=None, **kwargs):
    # Adapted from http://www.slideshare.net/zeeg/djangocon-2010-scaling-disqus
    """
    Updates specified attributes on the current instance.

    This creates an atomic query, circumventing some possible race conditions.
    """
    assert obj, "Instance has not yet been created."
    obj.__class__._base_manager.using(using)\
            .filter(pk=obj.pk)\
            .update(**kwargs)

    for k, v in kwargs.items():
        if isinstance(v, ExpressionNode):
            # Not implemented.
            continue
        setattr(obj, k, v)
