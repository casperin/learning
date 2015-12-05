/**
 *
 * This is the same setup, only more structured. The outcome is the same.
 *
 */

import { chan, go, putAsync, take } from 'js-csp';

// We no longer have a "global" channel.

// Reusable "listen" function that returns a channel where you can take out
// events as they appear.
function listen (el, action) {
    var ch = chan();

    el.addEventListener(action, function (event) {
        putAsync(ch, event);
    });

    return ch;
}

// Our "main" function. Asks the `listen` function to listen for mousemoves,
// and sets up a loop that responds to new events.
go(function* () {
    var el = document.getElementById('ui-box'),
        ch = listen(el, 'mousemove'),
        event;

    while (true) {
        event = yield take(ch);

        console.log(event.clientX, event.clientY);
    }
});

