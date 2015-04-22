var chan        = csp.chan,
    go          = csp.go,
    putAsync    = csp.putAsync,
    take        = csp.take;


// Slight edit to the function so it can now take a channel.
function listen (el, action, ch) {
    ch = ch || chan();

    el.addEventListener(action, function (event) {
        putAsync(ch, event);
    });

    return ch;
}

var getCoordinates = transducers.map(function (event) {
    return {
        x: event.clientX,
        y: event.clientY
    };
});

// Our "main" function. Asks the `listen` function to listen for mousemoves,
// and sets up a loop that responds to new events.
go(function* () {
    var el = document.getElementById('ui-box'),
        ch = listen(el, 'mousemove', chan(1, getCoordinates));

    while (true) {
        // Logs the coordinates.
        console.log(yield take(ch));
    }
});

