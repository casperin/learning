/**
 *
 * Generators are iterables (things you can call .next() on), so they're fun
 * with `for..of`.
 *
 * First a basic for..of
 *
 */

var arr = ['a', 'b', 'c'];

for (var letter of arr) {
    console.log(letter);    // Logs 'a', then 'b', then 'c'
}

// Notice that it gives you the actual content of array, and not just the
// index like for..in does.

// With a generator:
function* generator () {
    yield 'x';
    yield 'y';
    yield 'z';
    // Of course we could have written that as just
    // yield* ['x', 'y', 'z'];
}

// Notice that the for..of loop knows to stop when it won't get anything more
// meaningful out of the generator.
for (var value of generator()) {
    console.log(value);     // Logs 'x', then 'y', then 'z'
}

// for..of can iterate over many things:
var map = new Map();
map.set('a', 'x');
map.set('b', 'y');

for (var value of map) {
    console.log(value);     // Logs: ['a', 'x'], then ['b', 'y']
}

