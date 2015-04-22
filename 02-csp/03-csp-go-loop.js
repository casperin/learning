/**
 *
 * Infinite loops and generators and channels.
 *
 */

// No new functions.
var chan    = csp.chan,
    go      = csp.go,
    put     = csp.put,
    take    = csp.take,
    timeout = csp.timeout;

// Our trusted channel.
var ch = chan();

// A function that continually pops out values from our channel and logs them.
go(function* () {
    while (true) {
        var value = yield take(ch);

        console.log(value);
    }
});

// A bit silly perhaps, but it illustrates very well how async programming now
// doesn't use callbacks or promises anymore. It's just a flow.
go(function* () {
    yield put(ch, 1);           // after 0 ms
    yield take(timeout(500));
    yield put(ch, 2);           // after 500 ms
    yield take(timeout(500));
    yield put(ch, 3);           // after 1000 ms
});

/**
 *
 * Leaving the while loop "hanging" is not a problem. It will be garbage
 * collected as expected, and there are no performance issues of any kind. It
 * is literally paused until something puts something in the channel for it
 * take out and log.
 *
 */

