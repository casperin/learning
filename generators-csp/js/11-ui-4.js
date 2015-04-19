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
        mousedowns  = listen(el, 'mousedown'),
        mouseups    = listen(body, 'mouseup'),
        moves       = listen(body, 'mousemove'),
        pos         = {x: 0, y: 0},
        moving      = false,
        result, x, y, rect;

    while (true) {
        result      = yield alts([mousedowns, mouseups, moves]);
        x           = result.value.clientX;
        y           = result.value.clientY;

        if (result.channel === mousedowns) {
            moving = true;
        } else if (result.channel === mouseups) {
            moving = false;
        } else if (moving) {
            rect = el.getBoundingClientRect();

            el.style.left = (rect.left + x - pos.x) + 'px';
            el.style.top = (rect.top + y - pos.y) + 'px';
        }

        pos.x = x;
        pos.y = y;
    }
});



