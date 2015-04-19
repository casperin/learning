/**
 * How is it possible to use generators to get cleaner syntax when dealing with
 * async javascript?
 */

// A very simple mockup of a function resembling an async function returning a
// promise. Notice that it does not have any sort of error handling, nor does
// it really care about the url.  Instead of this function, we'd probably use
// some ajax library we got from npm.
function request (url) {
    return new Promise(function (resolve, reject) {
        setTimeout(function () {
            resolve('some data');
        }, 500);
    });
}

// This is our helper function. It takes as its argument a generator function,
// that has a single yield statement which gives us a promise.  It is about as
// simple as we can make it, with zero extra utility, and zero error handling.
function run (generator) {
    // Let's make our generator. The function itself is not being run yet.
    var gen = generator();

    // We call next on it, which moves things along to the first `yield`, which
    // passes an object to us. Something like: {value: Promise, done: false}.
    // The promise is the return value of the request() call, and it's the one
    // we're interested in.
    var promise = gen.next().value;

    // We attach a callback to the promise, which does only one thing: pass
    // along the data we receive from the promise, into a .next() method call
    // on the generator.  That's all there is to it.
    promise.then(function (data) {
        gen.next(data);
    });
}

// Notice that we need to wrap our generator function in another function. This
// is because whatever is helping us with the async logic, needs access to the
// generator function so that it can control when to call .next() on it, and
// thus move things along.
run(function* () {
    //  The function will pause here until the request has been resolved.
    var data = yield request('http://some.url');

    console.log('I got this data:', data);
});
