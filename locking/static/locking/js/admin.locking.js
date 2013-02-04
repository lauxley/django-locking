/*
Client side handling of locking for the ModelAdmin change page.

Only works on change-form pages, not for inline edits in the list view.
*/

// Make sure jQuery is available.
if (typeof jQuery === 'undefined') {
    jQuery = django.jQuery;
}

// Set the namespace.
var locking = locking || {};

// Begin wrap.
(function($, locking) {

// Global error function that redirects to the frontpage if something bad
// happens.
locking.error = function() {
    return;
    var text = ('An unexpected locking error occured. You will be' +
        ' forwarded to a safe place. Sorry!'
    );
    // Catch if gettext has not been included.
    try {
        alert(gettext(text));
    } catch(err) {
        alert(text);
    }
    window.location = '/';
};

/*
Delays execution of function calls with support for events that pauses the
script, like the use of alert().

Takes an array of arrays, each consisting of first the function to be delayed
and second the delay in seconds. Must be ordered after delays descending.

This is a one trick pony and must only be called once or bad things happens.
*/
locking.delay_execution = function(funcs) {
    var self = this;
    var begin_time = new Date().getTime();
    var execute = function() {
        var current_time = new Date().getTime();
        var delay = funcs[0][1];
        if ((current_time-begin_time) / 1000 > delay) {
            funcs[0][0]();
            funcs.shift();
            if (funcs.length === 0) clearInterval(self.interval_id);
        }
    };
    this.interval_id = setInterval(execute, 200);
    execute();
};

// Handles locking on the contrib.admin edit page.
locking.admin = function() {
    // Needs a try/catch here as well because exceptions does not propagate
    // outside the onready call.
    try {
        settings = locking.settings;
        need_unlock = true;

        var change_form = $('#' + locking.infos.change_form_id);

        // Don't apply locking mecanism if not on a change form page
        if (!locking.infos.change) return;

        // Get url parts.
        var adminSite = $.url.segment(0)
        var app = $.url.segment(1);
        var model = $.url.segment(2);
        var id = $.url.segment(3);

        // Urls.
        var base_url = "/" + [adminSite, app, model, id].join("/");
        var urls = {
            unlock: base_url + "/unlock/",
            refresh_lock: base_url + "/refresh_lock/"
        };
        // Texts.
        var text = {
            warn: gettext('Your lock on this page expires in less than %s minutes. Press save or <a href=".">reload the page</a>.'),
            is_locked: gettext('This page is locked by <em>%(for_user)s</em> and editing is disabled. Ask him/her to release the lock and then try <a href=".">reloading the page</a>.'),
            editing: gettext('(you are in edit mode)'
            ),
            has_expired: gettext('Your lock on this page is expired! Saving your changes might not be possible, but you are welcome to try.'
            ),
            was_already_locked: gettext('It appears that you were already editing this page (maybe in another tab or window ?). If you think this is a mistake, you can choose to <a href="#force-release" class="force-release">force-release the lock</a>.'
            ),
            prompt_to_save: 'Do you wish to save the page?',
        };

        var errors_when_saving = {
            was_already_locked: gettext('It appears that you were already editing this page (maybe in another tab or window ?). If you think this is a mistake, you can choose to <a href="#force-save" class="force-save">force saving</a>.'
            ),
            not_locked_and_modified: gettext('It appears that object was modified since you extracted it. You can choose to <a href="#force-save" class="force-save">force saving</a> but you may override some changes...'
            ),
            locked_by_someone_else: gettext('%s is editing this object ! Before saving, you need to ask him/her to release the lock. Note that if he/she saves, conflicts may happen.'
            ),
        }

        // Creates empty span after change page title
        var create_OK_area = function() {
            $("#content-main").siblings('h1').append(' <span id="locking_ok"></span>');
        };

        var notify_edit_mode = function() {
            $('#locking_ok').text(text.editing);
            // Empty and hide notification area
            $("#content-main #locking_notification").hide().html('');
        };

        // Creates empty div in top of page.
        var create_notification_area = function() {
            $("#content-main").prepend(
                '<div id="locking_notification"></div>');
        };

        // Creates errornote div in top of page if it doesn't already exist
        var create_error_area = function() {
            var errornote = $('.errornote', change_form);
            if (errornote.length === 0) {
                $('<p class="errornote"></p>').prependTo(change_form).hide();
            }
        };

        // Scrolls to the top, updates content of notification area and fades
        // it in.
        var update_notification_area = function(content, func) {
            $('html, body').scrollTop(0);
            $("#content-main #locking_notification").html(content).hide()
                                                    .fadeIn('slow', func);
        };

        var update_error_area = function(content) {
            var errornote = $('.errornote');
            var lastErrorElm = errornote.siblings(".errorlist");
            if (lastErrorElm.length === 0) {
                lastErrorElm = errornote;
            }
            $('<ul class="errorlist"></ul>').html('<li>' + content + '</li>').insertAfter(lastErrorElm);
        };

        // Displays a warning that the page is about to expire.
        var display_warning = function() {
            var promt_to_save = function() {
                if (confirm(text.prompt_to_save)) {
                    $('input[type=submit][name=_continue]', change_form).click();
                }
            };
            var minutes = Math.round((settings.time_until_expiration -
                settings.time_until_warning) / 60);
            if (minutes < 1) minutes = 1;
            update_notification_area(interpolate(text.warn, [minutes]),
                                     promt_to_save);
        };

        // Displays notice on top of page that the page is locked by someone
        // else.
        var display_islocked = function(data) {
            update_notification_area(interpolate(text.is_locked, data, true));
        };

        // Displays notice on top of page that the page was already locked by
        // current user
        var display_wasalreadylocked = function(data) {
            update_notification_area(interpolate(text.was_already_locked, data, true));
        };

        // Disables all form elements.
        var disable_form = function() {
            $(":input[disabled]", change_form).addClass('_locking_initially_disabled');
            $(":input", change_form).attr("disabled", "disabled");
            change_form.addClass('disabled');
            change_form.trigger('locking-form-disable', { form: change_form.get(0) });
        };

        // Enables all form elements that was not disabled from the start.
        var enable_form = function() {
            $(":input", change_form).not('._locking_initially_disabled')
                       .removeAttr("disabled");
            change_form.removeClass('disabled');
            change_form.trigger('locking-form-enable', { form: change_form.get(0) });
        };

        // The user did not save in time, expire the page.
        var expire_page = function() {
            update_notification_area(text.has_expired);
        };

        var request_unlock = function() {
            // We have to assure that our unlock request actually gets
            // through before the user leaves the page, so it shouldn't
            // run asynchronously.
            if (need_unlock) {
               $.ajax({
                 url: urls.unlock,
                 async: false,
                 cache: false
               });
            }
        };

        var remove_ajax_unload = function() {
            // we need a global variable to be safer, 
            // because sometimes the event 'unload' is triggered before it is unbound
            need_unlock = false;
            $(window).unbind('unload', request_unlock);
        };

        var initialize_edit_mode = function() {
                notify_edit_mode();

                // Warn that lock will expire if he stays too long...
                locking.delay_execution([
                    [display_warning, settings.time_until_warning],
                    [expire_page, settings.time_until_expiration]
                ]);
                // Unlock page when user leaves the page without saving
                $(window).bind('unload', request_unlock );
                // If user is saving, don't ask for unlocking, it will
                // be done python-ly
                change_form.bind('submit', remove_ajax_unload);
        };

        var request_refresh_lock = function(force_save) {
            var parse_refresh_lock_response = function(data, textStatus, jqXHR) {
                if (jqXHR.status === 409) {
                    alert("Unable to unlock the object, it is already locked by someone else !");
                    return;
                } else if (jqXHR.status === 200) {
                    $('input[name="original_locked_at"]', change_form).attr("value", data.original_locked_at);
                    $('input[name="original_modified_at"]', change_form).attr("value", data.original_modified_at);
                    if (force_save) {
                        $('input[type=submit][name=_continue]', change_form).click();
                    } else {
                        // force_save is not asked, just enable form
                        initialize_edit_mode();
                        enable_form();
                        notify_edit_mode();
                    }
                } else {
                    locking.error();
                }
            };
            $.ajax({
                url: urls.refresh_lock,
                success: parse_refresh_lock_response,
                cache: false,
                error: locking.error
            });
        };

        // Analyse locking_info and disable form if necessary
        var lock_if_necessary = function() {
            if (locking.infos.is_POST_response && locking.infos.error_when_saving) {
                // User tried to save but there was a locking problem
                // We then assume it was editing the page, so display error
                // and enable form
                $('body').delegate('a.force-save', 'click', function(e) {
                    force_save = true;
                    request_refresh_lock(force_save);
                    return false;
                });
                update_error_area(interpolate(errors_when_saving[locking.infos.error_when_saving], [locking.infos.for_user]));
                initialize_edit_mode();
            }
            else if (locking.infos.was_already_locked_by_user) {
                // An active lock by this user was found when loading the page.
                // Disable form, warn him and allow him to ignore the old lock
                disable_form();
                $('body').delegate('a.force-release', 'click', function(e) {
                    request_refresh_lock();
                    return false;
                });
                display_wasalreadylocked(locking.infos);
            }
            else if (locking.infos.applies) {
                disable_form();
                display_islocked(locking.infos);
            } else { // page is not locked for user
                enable_form();
                initialize_edit_mode();
            }
        }

        // Initialize.
        create_OK_area();
        create_notification_area();
        create_error_area();
        lock_if_necessary();

    } catch(err) {
        locking.error();
    }
};

// Catches any error and redirects to a safe place if any.
try {
    $(locking.admin);
} catch(err) {
    locking.error();
}

// End wrap.
})(jQuery, locking);
