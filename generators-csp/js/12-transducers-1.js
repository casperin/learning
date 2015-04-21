/* globals csp, console, transducers */

/**
 * Work in progress.
 */

var chan        = csp.chan,
    go          = csp.go,
    putAsync    = csp.putAsync,
    takeAsync   = csp.takeAsync;

var xAdd10 = transducers.map(function (x) {
    return x + 10;
});

var c = chan(2, xAdd10);

putAsync(c, 1);

takeAsync(c, function (data) {
    console.log('I got:', data);    // I got: 11
});

