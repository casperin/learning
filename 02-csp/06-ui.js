/**
 *
 * Here's simple setup for working with the ui. The advantages of using a
 * channel are not apparent here. It is just to show how it is done in its
 * simplest form.
 *
 */

var chan        = csp.chan,
    go          = csp.go,
    putAsync    = csp.putAsync,
    take        = csp.take;

var ch = chan();

// This should be a 500x300 purple box in index.html
var el = document.getElementById('ui-box');

// We attach an event listener that listens for mouse moves, and whenever we
// get an event, we just put it in the channel.
el.addEventListener('mousemove', function (event) {
    putAsync(ch, event);
});

// Meanwhile, somewhere else, we take out the events of the channel and log
// them to the console.
go(function* () {
    var event;

    while (true) {
        event = yield take(ch);

        console.log(event.clientX, event.clientY);
    }
});

/**
 *
 * This is the basic premise we're working with. In this particular example,
 * there is no reason why the function we attach as an event listener doesn't
 * just log the coordinates itself.
 *
 */

