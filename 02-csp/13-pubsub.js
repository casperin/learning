// Let's implement a simple pub/sub system with channels. We use a lot of channels for this. One, to
// broadcast, and then one for each subscriber. The broadcaset, `broadcaster`, takes care of passing
// messages from our `broadcast` channel, to each of the "out going" channels.
var go      = csp.go,
    chan    = csp.chan,
    put     = csp.put,
    putAsync= csp.putAsync,
    take    = csp.take,
    buffers = csp.buffers;


// Takes a channel that it itself listens to.
function broadcaster (ch) {
    // Right now we have no subscribers, so no channels.
    var channels = [];

    go(function* (){
        while (true) {
            // Whenever we receive a message...
            var value = yield take(ch);

            for (var channel of channels) {
                // ... we put it into a channel (and block until it has been picked up)
                yield put(channel, value);
            }
        }
    });

    // Our subsribe function
    return function () {
        // It's important that our outgoing buffers drops previous items as new ones come in.
        // See: https://github.com/ubolonton/js-csp/blob/master/doc/basic.md#buffersslidingn
        // Otherwise, if a subscriber does not listen to (`take` out values) as they come in, they
        // would block the broadcaster from publishing the next events.
        var ch = chan(buffers.sliding(1));

        channels.push(ch);

        return ch;
    };
}

// So this is the channel we will put values into, to broadcast them.
var broadcast = chan();

// And this is out subscribe function. Notice, that this is the only time that we touch the
// `broadcaster`, and the following two subscribtions are the only time we touch the anything other
// than channels.
var subscribe = broadcaster(broadcast);

var ch1 = subscribe();
var ch2 = subscribe();

// Listen for messages coming down the first channel.
go(function* () {
    while (true) {
        var value = yield take(ch1);

        console.log('from subscriber 1:', value);
    }
});

// After 100 ms, we pump in 3 messages.
setTimeout(function () {
    putAsync(broadcast, 'message 1');
    putAsync(broadcast, 'message 2');
    putAsync(broadcast, 'message 3');
}, 100);

// And after 500 ms we listen on the second channel. Notice that we still receive the last message
// passed into our broadcast channel. This is because of the `buffers.sliding(1)`. Had it been
// `buffers.sliding(2)`, we would have received the two last messages, and so on.
setTimeout(function () {
    go(function* () {
        while (true) {
            var value = yield take(ch2);

            console.log('from subscriber 2:', value);
        }
    });
}, 500);

