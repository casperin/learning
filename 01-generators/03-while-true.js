/**
 *
 * A very common "pattern" with generators is to create infinite loops with a
 * yield inside.
 *
 */

// Whenever .next() is called on the generated function it will return
// {value: "Hello world", done: false}.
function* generator () {
    while (true) {
        yield 'Hello world';
    }
}

var gen = generator();

console.log(gen.next());
console.log(gen.next());
console.log(gen.next());
console.log(gen.next());
// forever...

