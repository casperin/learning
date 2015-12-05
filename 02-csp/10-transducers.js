/* globals csp, console, transducers */

/**
 *
 * Let's have a look at transducers in the context of channels.
 *
 * Here's a super basic example. Notice, that "mapping" when we are talking
 * about channels, means we are "mapping a function over" each value coming
 * through the channel. It has nothing to do with mapping over an array.
 *
 */

import transducers from 'transducers.js';
import {chan, putAsync, takeAsync} from 'js-csp';

// Function that we wish to map over each value.
function add10 (x) {
    return x + 10;
}

// We turn it into a "transducer". If you don't know what that is, then just
// think of it as an advanced "map" function.
var transAdd10 = transducers.map(add10),

    // We make a channel. The `1` here, means it's a buffered channel (it can
    // hold one value at a time). We can of course buffer it to any number we
    // like. The only reason we do this for now, is because it is required if
    // we want to add a transducer to it.
    c = chan(1, transAdd10);

// We add a number as we always do.
putAsync(c, 3);

// And when we take out the number, it will have gone through a transformation
// that we asked for.
takeAsync(c, function (data) {
    console.log('I got:', data);    // I got: 13
});

