/**
 * Basic generator example.
 */

// Generator function
function* generator () {
    console.log('start');

    var a = yield 'give me a number!';

    return a + 1;
}

// Nothing happens here. If you look at `gen` in the console, then you'll see a
// "generator" with some methods on the prototype. The only method we will be
// using here is .next().
var gen = generator();

gen.toString(); // "[object Generator]"

var result1 = gen.next(); // {value: "give me a number!", done: false}

// 'start' is logged, meaning this is the first time we "enter" the function.

// result1 is called a "generator result".

// The generator is now paused at the first yield, waiting for something to
// assign to `a`. Let's do that.

gen.next(2); // {value: 3, done: true}

// Since we reached a "return", we are now being told that done is true (so
// calling it again will not give us anything more meaningful).

gen.next(); // {value: undefined, done: true}
gen.next(); // {value: undefined, done: true}
// ...
