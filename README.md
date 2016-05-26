### Node Compiler

Node Compiler is a command-line utility that compiles your Node.js application into a single executable file. its based on Nexe project [https://github.com/jaredallard/nexe]

in the production project environment, we found there is a limit about processing the compilicate node.js modules dependency if using nexe, so we decided to fork and extend the project to make it easily to handle large node.js project.

e.g: today mongodb with node.js is very popular, but by using default nexe, we could not easily produce a working binary which with with monogoose + express.js , well even i know where is the problem, but cannot modify ton of mongodb's driver code, btw, i also like their way to dynamicly load dependencies even its making me some trouble now.

Actually we found the problem is about intergrate browserify (which to make the whole project into one file ), so we have optimized the config parser, it now much easier to handle *require(variableName)* issue. 

Later one I will explain how exactly it works

Below part is original from nexe document:

### Motivation

- Ability to run multiple applications with *different* node.js runtimes.
- Distributable binaries without needing node / npm.
- Starts faster.
- Lockdown specific application versions, and easily rollback.
- Faster deployments.

## Building Requirements

- Linux / Mac / BSD / Windows
- Python 2.6 or 2.7 (use --python if not in PATH)
- Windows: Visual Studio 2010+

## Caveats

### Doesn't support native modules

- Use the techniques below for working around dynamic require statements to exclude the module from the bundling, and deploy along side the executable in a node_module folder so your app can find it. Note: On windows you may need to have your app be named node.exe if .node file depends on node.
