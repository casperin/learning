// Basic async functions work with promises

// Helper function that returns a promise which, after 1 second, resolves with the value `42`.
const gimme42 = () => new Promise((resolve, reject) => {
    setTimeout(() => resolve(42), 1000);
});

// Our infamous async function
async function shoutIt () {
    // The function blocks here, waiting for the promise to be resolved.
    const value = await gimme42();

    console.log('I got', value);
};

// And we call it.
shoutIt();

