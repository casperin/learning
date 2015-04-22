/**
 *
 * A generator can pass off responsibility to another generator with yield*.
 *
 */

function* generator1 () {
    yield 1;
    yield* generator2();
    yield 4;
}

function* generator2 () {
    yield 2;
    yield 3;
}

var gen = generator1();

console.log(gen.next()); // {value: 1, done: false}
console.log(gen.next()); // {value: 2, done: false}
console.log(gen.next()); // {value: 3, done: false}
console.log(gen.next()); // {value: 4, done: false}
console.log(gen.next()); // {value: undefined, done: true}

