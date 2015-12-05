// Not the same anymore. This one rejects its promise
const gimme22 = () => new Promise((resolve, reject) => {
    setTimeout(() => reject(22), 1000);     // Rejects!
});

async function shoutIt () {
    try {
        // Awaiting a function that fails, will actually throw an error!
        await gimme22();
        console.log('this will never be logged');
    } catch (err) {
        console.log('I failed :(', err); // err = 22
    }
};

shoutIt();
