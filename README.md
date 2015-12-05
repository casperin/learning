# Simple JavaScript examples

I thought I'd have a look into generators, csp, and transducers and (because I
feel more tutorials and examples are severely lacking) document my way through
it.

## How should I work with this?

Clone the project, `npm install` to install modules, and finally `npm start` to
start compiling files as you make changes.

```sh
git clone https://github.com/casperin/learning.git
cd learning
npm install
npm start
```

Open `./index.js` in your editor and start uncommenting the files, one at a
time. Read the source documentation of the file and edit it as you please. Once
you get the hang of it, comment it out again and comment in the next file.

You can view changes in the console output if you open `www/index.html`.

Alternatively, you can just open each file here on Github and read.

I've tried to make it as simple as possible, and then even simpler. To cut
everything irrelevant away when introducing new concepts. Then build upon them.
Slowly. If you feel you can improve upon that, then by all means, send a pull
request.

## Libraries

- [js-csp](https://github.com/ubolonton/js-csp)
- [transducers.js](https://github.com/jlongster/transducers.js)

## Resources

These have been my primary sources to rip off. This is where you should go to
understand more on the topic.

- [Taming the Asynchronous Beast with CSP Channels in
  JavaScript](http://jlongster.com/Taming-the-Asynchronous-Beast-with-CSP-in-JavaScript)
  by James Long. (Almost all of the more complex examples are directly taken
  from this post. Go read!).
- [CSP and transducers in
  JavaScript](http://phuu.net/2014/08/31/csp-and-transducers.html) by Tom
  Ashworth.
- [ES6 Generators Deliver Go Style
  Concurrency](http://swannodette.github.io/2013/08/24/es6-generators-and-csp/)
  by David Nolen.

