/**
 *
 * Let's have one "go process" call out, and another respond to it.
 *
 * Notice, that the senders of the messages have no way of knowing who will
 * pick up their message.
 *
 */

import {
    chan,
    go,
    put,
    take,
    timeout
} from 'js-csp';

var ch = chan();

go(function* () {
    yield put(ch, 'Anybody out there?');

    var answer = yield take(ch);

    console.log(answer); // 'I am here.'
});

go(function* () {
    var call = yield take(ch);

    console.log(call); // 'Anybody out there?'

    yield take(timeout(500));

    // Answers...
    yield put(ch, 'I am here.');
});

/**
 *
 * Here you see two generator functions communicating with each other via a
 * channel. If it seems a little cumbersome, then it's because it is. This is
 * purely to drive the point home that "go processes" do not know about each
 * other, they only communicate via channels (but usually more gracefully than
 * this).
 *
 */
