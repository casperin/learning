/**
 *
 * Let's handle multiple "event streams" with one handler.
 *
 */

import {
    chan,
    go,
    putAsync,
    alts    // The new kid in class.  We will be using it instead of `take`.
} from 'js-csp';

// Exactly the same function as in previous example.
function listen (el, action) {
    var ch = chan();

    el.addEventListener(action, function (event) {
        putAsync(ch, event);
    });

    return ch;
}

go(function* () {
    var el              = document.getElementById('ui-box'),
        // This time, we are interested in two types of events, so we are
        // working with two channels.
        clicksChannel   = listen(el, 'click'),
        movesChannel    = listen(el, 'mousemove'),
        result, x, y;

    while (true) {
        // When using `csp.alts` we don't just get the value (the event) out.
        // Instead we get an object like this: {channel: Channel, value: event}
        result = yield alts([clicksChannel, movesChannel]);
        x = result.value.clientX;
        y = result.value.clientY;

        // Comparing the `.channel` of our result, we can figure out which
        // channel it comes from, and thus how we should handle it.
        if (result.channel === clicksChannel) {
            console.log('clicked:', x, y);
        } else {
            console.log('moved:', x, y);
        }
    }
});


