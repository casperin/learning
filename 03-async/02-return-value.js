// Same helper as before.
const gimme42 = () => new Promise((resolve, reject) => {
    setTimeout(() => resolve(42), 1000);
});

// Same async function as before, except it return a value.
async function shoutIt () {
    const value = await gimme42();

    console.log('I got', value);

    return 'end of async function'; // new part of this function.
};

// Async functions return a promise themselves.
shoutIt().then(returnValue => console.log(returnValue));


// Can it fail? Maybe if it throws?
async function throwingAsync () {
    throw 'hello?';
};

// Yup. This logs "caught this: hello?"
throwingAsync().catch(err => console.log('caught this:', err));


