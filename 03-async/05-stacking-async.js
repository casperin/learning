// Since an async function returns a promise, and await operates on promises, we aught to be able to
// just await other async functions, making them stack up nicely.

// Returns a promise, that will randomly resolve (returning 1) or reject (returning 22).
const getOne = () => new Promise((resolve, reject) => {
    setTimeout(() => {
        Math.random() > .5
            ? resolve(1)
            : reject(22);
    }, 1000);
});

async function getThree () {
    const one = await getOne();     // May resolve or reject. We don't know. If it fails, it will
                                    // jump directly to the catch block at the very end.
    return one + 2;
}

// Apparently there's an async arrow function syntax. Great :)
const getSix = async () => {
    const three = await getThree();
    return three + 3;
}

getSix()
    .then(six => console.log('got', six))
    .catch(err => console.log('catch', err));

async function* getStocks() {
}
