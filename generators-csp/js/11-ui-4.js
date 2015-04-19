/* globals csp, console */

/**
 *
 * Let's build a simple drag and drop system. This requires handling three types of events:
 *
 * 1. mousedown - Start dragging
 * 2. mouseup   - Stop dragging
 * 3. mousemove - If mouse is down, move element around.
 *
 * Each of these will be handled by the same handler.
 *
 */

var chan        = csp.chan,
    go          = csp.go,
    putAsync    = csp.putAsync,
    alts        = csp.alts;         // The new kid in class. We will be using
                                    // it instead of `take`.

// Same function as in previous examples.
function listen (el, action) {
    var ch = chan();

    el.addEventListener(action, function (event) {
        putAsync(ch, event);
    });

    return ch;
}

go(function* () {
    var el          = document.getElementById('ui-box'),
        body        = document.body,

        // Notice that we aren't listening to events on the same element.
        mousedowns  = listen(el, 'mousedown'),
        mouseups    = listen(body, 'mouseup'),
        moves       = listen(body, 'mousemove'),
        pos         = {x: 0, y: 0},     // Our starting point.
        moving      = false,            // Not moving initially.
        result, x, y, rect;

    while (true) {
        // Again we use `csp.alts`, this time with three channels.
        result      = yield alts([mousedowns, mouseups, moves]);
        x           = result.value.clientX;
        y           = result.value.clientY;

        // Then we handle each case separately:
        if (result.channel === mousedowns) {
            moving = true;
        } else if (result.channel === mouseups) {
            moving = false;
        } else if (moving) {
            // Actually moving the element.
            rect = el.getBoundingClientRect();
            el.style.left = (rect.left + x - pos.x) + 'px';
            el.style.top = (rect.top + y - pos.y) + 'px';
        }

        // Save the new mouse position.
        pos.x = x;
        pos.y = y;
    }
});

/**
 *
 * Notice how we can use the js-csp library, and our trusty `listen` function,
 * to build fairly complex behavior in relatively few lines of code.
 *
 * More importantly, the way events are handled here maps very well to our
 * minds. To quote James Long in his excellent article on the same topic:
 *
 *      Expressing UI interactions with alts maps extremely well to how we
 *      intuitively think about them. It allows us to wrap events together into
 *      a single event, and respond accordingly. No callbacks, no event
 *      handlers, no tracking state across functions. We think about UI
 *      interactions like this all the time, why not express your code the same
 *      way?
 *
 */


