// Still returns a promise that rejects after 1 sec.
const gimme22 = () => new Promise((resolve, reject) => {
    setTimeout(() => reject(22), 1000);     // Rejects!
});

async function shoutIt () {
    const value = await gimme22(); // shoutIt will reject its promise right here.

    return 'the return of shouting'; // This will never be reached.
};

shoutIt()
    .then(v => console.log('then', v))      // This will be skipped
    .catch(v => console.log('catch', v))    // Instead we will catch the error from `gimme22`.

