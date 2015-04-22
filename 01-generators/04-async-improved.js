/**
 *
 * Improving a bit on the async function so you can call more than just one
 * promise.
 *
 */

// Same mock request function
function request (url) {
    return new Promise(function (resolve, reject) {
        setTimeout(function () {
            resolve('some data from ' + url);
        }, 500);
    });
}

function run (generator) {
    var gen = generator();

    function nxt (value) {
        var response = gen.next(value),
            promise = response.value;

        if (response.done) {
            return;
        }

        promise.then(function (value) {
            nxt(value);
        });
    }

    nxt();
}

run(function* () {
    // It won't start the second request until the first one has been resolved.
    var data1 = yield request('http://some.url'),
        data2 = yield request('http://another.url');

    // These will be logged after both requests have finished processing and
    // returned.
    console.log('I got this data:', data1);
    console.log('I also got this data:', data2);
});
