/**
 *
 * Here's a little more complex example of a broadcaster that sends messages,
 * one way, out to three receivers that pick up messages and proccess them
 * whenever they can.
 *
 */

import {
    chan,
    go,
    put,
    take,
    timeout,
    CLOSED
} from 'js-csp';


var ch = chan();

// The broadcaster. It sends out 20 messages, one every 100 ms, when done, it
// closes the channel.
go(function * () {
    for (var i = 0; i < 20; i++) {
        yield take(timeout(100));
        yield put(ch, i);
    }

    yield ch.close();
});

// Helper function to create workers. The name is to distinguish the workers,
// and the pause is the length of the break between each task they can take on.
function worker (name, pause) {
    // It just returns what we'd normally put in a `go()` call.
    return function* () {
        // We keep listening forever and ever... until we break out.
        while (true) {
            // Worker pauses here until it has a value to work with.
            var value = yield take(ch);

            // If the channel is empty and closed, then we break out of the
            // loop and thus terminate the function.
            if (value === CLOSED) {
                break;
            } else {
                // [insert some heavy working here...]

                console.log(name, 'did task', value);

                // *phew* - time for a quick nap.
                yield take(timeout(pause));
            }
        }

        console.log(name, 'is done for today.');
    };
}

// Let's make some workers and get them to work.
go(worker('Alice', 450));
go(worker('Bob', 600));
go(worker('Charlie', 2500));

/**
 *
 * When this is run in the browser, the output in the console will be:
 *
 *      Alice did task 0
 *      Bob did task 1
 *      Charlie did task 2
 *      Alice did task 3
 *      Bob did task 4
 *      Alice did task 5
 *      Bob did task 6
 *      Alice did task 7
 *      Alice did task 8
 *      Bob did task 9
 *      Alice did task 10
 *      Bob did task 11
 *      Charlie did task 12
 *      Alice did task 13
 *      Bob did task 14
 *      Alice did task 15
 *      Alice did task 16
 *      Bob did task 17
 *      Alice did task 18
 *      Bob did task 19
 *      Alice is done for today.
 *      Bob is done for today.
 *      Charlie is done for today.
 *
 * It's worth noticing that the broadcaster has no idea about who is doing
 * what, and how much time they spent on each task. It just adds tasks to the
 * channel, and workers pick them up and "process" them as fast as they can.
 *
 * Similarly, the workers have no idea who is adding tasks to the channel. All
 * they care about is processing them and waiting for new tasks to arrive.
 *
 * Doing this with only promises or callbacks, would be significantly more
 * difficult.
 *
 * Even more so, imagine that the workers create a sort of bottle neck in our
 * system in times where a broadcaster fires out many tasks. How easy would it
 * be to add some oberserver to the channel that would spawn new workers and
 * shut them down as needed depending on the number of tasks in the pipeline
 * (the channel)?
 *
 */

