/* globals csp, console */

/**
 *
 * `csp.chan` creates channels, used for communication (for passing messages).
 *
 * `csp.putAsync` puts messages into the channel for others to pick up.
 *
 * `csp.takeAsync` retrieves the message.
 *
 * Notice, that everything in the following code, is done via callbacks. This
 * is why we are using the async versions of put and take. The real ones, are
 * designed to work with generators.
 *
 */

// These are the functions we will be learning/using.
var chan        = csp.chan,
    putAsync    = csp.putAsync,
    takeAsync   = csp.takeAsync;

// First we create the channel for communication. Think of a "channel" as a
// funnel, or a bucket, that we can put things into, and take things out of.
var c = chan();

putAsync(c, 1);     // put "1" in the channel.

// Logs 'I got: 1'
takeAsync(c, function (data) {
    console.log('I got:', data);
});

// If there is no data in the channel, then log is not called.
takeAsync(c, function (data) {
    console.log('Now I got:', data);    // Nothing logged, yet.
});

// However, when we add something, it gets logged out:
putAsync(c, 2); // 'Now I got: 2' is now logged.

// We can add as many as we like, and get them out, one at a time.
putAsync(c, 3);
putAsync(c, 4);
putAsync(c, 5);

// Now the channel contains three items. Let's get them out:

takeAsync(c, function (data) {
    console.log('first item:', data);       // logs 'first item: 3'.
});

takeAsync(c, function (data) {
    console.log('second item:', data);      // logs: 'second item: 4'.
});

takeAsync(c, function (data) {
    console.log('and last item:', data);    // logs: 'and last item: 5'.
});

/**
 * Interestingly, if this is all run in the browser, then the logged out
 * messages will look like this:
 *
 *      I got: 1
 *      first item: 3
 *      second item: 4
 *      and last item: 5
 *      Now I got: 2
 *
 * In other words, the callback that did not have any value to retrieve at
 * first, was put at the end of the queue of tasks to being be processed.
 *
 */

