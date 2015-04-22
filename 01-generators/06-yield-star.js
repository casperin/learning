/**
 *
 * yield* with arrays.
 *
 */

function* generator () {
    // It will give you one value at a time!
    yield* [1, 2, 3];
}

var gen = generator();

console.log(gen.next());    // {value: 1, done: false}
console.log(gen.next());    // {value: 2, done: false}
console.log(gen.next());    // {value: 3, done: false}
