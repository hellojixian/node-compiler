/**
 * Copyright (c) 2013 Craig Condon
 * Copyright (c) 2015-2016 Jared Allard
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 **/

'use strict';

const async = require("async"),
  mkdirp    = require("mkdirp"),
  recursiveReadSync = require('recursive-readdir-sync'),
  request   = require("request"),
  gunzip    = require("gunzip-maybe"),
  path      = require("path"),
  fs        = require("fs-extra"),
  tarstream = require('tar-stream'),
  colors    = require('colors'),
  ncp       = require("ncp").ncp,
  ProgressBar = require("progress"),
  child_process = require("child_process"),
  glob      = require("glob"),
  bundle    = require("./bundle"),
  embed     = require("./embed"),
  os        = require("os"),
  _log      = require("./log"),
  _monkeypatch = require("./monkeypatch"),  
  spawn     = child_process.spawn;

const isWin = /^win/.test(process.platform);

let isPy,
    framework,
    version;

/**
 * Compiliation process.
 */

exports.compile = function(options, complete) {

  var nodeCompiler, nexeEntryPath;

  async.waterfall([
    /**
     *check relevant options
     */
    function checkOpts(next) {
      /* failsafe */
      if (options === undefined) {
        _log("error", "no options given to .compile()");
        process.exit()
      }

      /**
       * Have we been given a custom flag for python executable?
       **/
      if (options.python !== 'python' && options.python !== "" && options.python !== undefined) {
        if (isWin) {
          isPy = options.python.replace(/\//gm, "\\"); // use windows file paths, batch is sensitive.
        } else {
          isPy = options.python;
        }

        _log("set python as " + isPy);
      } else {
        isPy = "python";
      }

      // remove dots
      options.framework = options.framework.replace(/\./g, "");

      // set outter-scope framework variable.
      framework = options.framework;
      _log("framework => " + framework);

      version = options.nodeVersion; // better framework vc

      // check iojs version
      if (framework === "iojs" && version === "latest") {
        _log("fetching iojs versions");
        mkdirp(options.nodeTempDir); // make temp dir, probably repetive.

        // create write stream so we have control over events
        var output = fs.createWriteStream(path.join(options.nodeTempDir,
          "iojs-versions.json"));

        request.get("https://iojs.org/dist/index.json")
          .pipe(output);

        output.on('close', function() {
          _log("done");
          var f = fs.readFileSync(path.join(options.nodeTempDir,
            "iojs-versions.json"));
          f = JSON.parse(f);
          version = f[0].version.replace("v", "");

          _log("iojs latest => " + version);

          // continue down along the async road
          next();
        });
      } else {
        next();
      }
    },

    /**
     * first download node
     */
    function downloadNode(next) {
      _downloadNode(version, options.nodeTempDir, options.nodeConfigureArgs, options.nodeMakeArgs, options.nodeVCBuildArgs, next);
    },

    /**
     * Embed Resources into a base64 encoded array.
     **/
    function embedResources(nc, next) {
      nodeCompiler = nc;

      _log("embedResources %s", options.resourceFiles);
      embed(options.resourceFiles, options.resourceRoot, nc, next);
    },

    /**
     * Write compiledres.js
     **/
    function writeResources(resources, next) {
      let resourcePath = path.join(nodeCompiler.dir, "lib", "compiledres.js");
      _log("resource -> %s", resourcePath);

      fs.writeFile(resourcePath, resources, next);
    },

    /**
     * Bundle the application into one script
     **/
    function combineProject(next) {
      _log("bundle %s", options.input);
      bundle(options.input, nodeCompiler.dir, options, next);
    },

    
    /**
     * monkeypatch some files so that the compiled.js file is loaded when the app runs
     */

    function monkeyPatchNodeConfig(next) {      
      _monkeyPatchNodeConfig(nodeCompiler, next);
    },

    /**
     * monkeypatch node.cc to prevent v8 and node from processing CLI flags
     */
    function monkeyPatchNodeCc(next) {
      if (options.flags) {
        _monkeyPatchMainCc(nodeCompiler, next);
      } else {
        next();
      }
    },

    function monkeyPatchv8FlagsCc(next) {
      if (options.jsFlags) {
        return _monkeyPatchv8FlagsCc(nodeCompiler, options, next);
      }

      return next();
    },

    /**
     * monkeypatch child_process.js so nexejs knows when it is a forked process
     */
    function monkeyPatchChildProc(next) {
      _monkeyPatchChildProcess(nodeCompiler, next);
    },

    //process native modules
    function embedNativeModules(next) {
      var browserify    = require('browserify'),            
          UglifyJS      = require("../tools/node");
      
      async.map(options.native,function(nativeModule,cb)
      {
          async.waterfall([
            /**
             * generate single js file
             * modify js change require .node => process.binding
             */  
            function processSingleJS(n){
                     
              const bundlePath = path.join(nodeCompiler.dir, "lib", nativeModule.name+".js");        
              const ws         = fs.createWriteStream(bundlePath);
              const paths = [path.join(nodeCompiler.dir, 'lib')];
              const bproc = browserify([nativeModule.js], {          
                commondir: false,
                paths: paths,
                builtins: false,
                insertGlobalVars: false,
                detectGlobals: true,
                browserField: false
              });

              const bprocbun = bproc      
                    .bundle() // bundle
                    .pipe(ws) // pipe to file

              ws.on('close', function() {
                var source = fs.readFileSync(bundlePath, 'utf8');          
                source = source.replace(/[^\x00-\x7F]/g, "");
                
                // modify js change require .node => process.binding
                source = source.replace(/require\(.*?\.node.*?\)/g, "process\.binding(\'"+nativeModule.name+"\')");

                var result = UglifyJS.minify(source, {fromString: true});
                source = result.code;                  
                // write the source modified to compiled.js
                fs.writeFileSync(bundlePath, source, {encoding:'utf8'});
                n();              
              });  
            },
            /**
             * copy cc files
             * patch main cc files
             */  
            function processCCFile(n)
            {
              var modulePath = path.join(nodeCompiler.dir, "src", nativeModule.name);
              fs.ensureDirSync(modulePath);              

              //copy source files               
              fs.copySync(nativeModule.sources,modulePath);

              // patch and copy main cc file
              var bundlePath = path.join(nodeCompiler.dir, "src", nativeModule.name,path.basename(nativeModule.cc));
              var source = fs.readFileSync(nativeModule.cc,'utf8');
              source = source.replace("NODE_MODULE("+nativeModule.name+", init)","NODE_MODULE_CONTEXT_AWARE_BUILTIN("+nativeModule.name+", init)");
              fs.writeFileSync(bundlePath, source, "utf8");

              n();
            },

            /**
             * patch node.gyp
             */
            function patchNodeGyp(n)
            {
              var extFile = path.join(nodeCompiler.dir, "node.gyp");
              var source = fs.readFileSync(extFile,'utf8');                           
              var ext_cc = "";
              // add main js
              if(source.indexOf(nativeModule.name+".js")==-1){
                source = source.replace("'lib/fs.js'","'lib/fs.js','lib/"+nativeModule.name+".js'");
              }
              // add source files              
              if(source.indexOf(path.basename(nativeModule.cc))==-1){
                var files = recursiveReadSync(nativeModule.sources);                
                for(var i in files){                
                  var file = files[i];
                  if(path.basename(file)!=path.basename(nativeModule.cc)){
                    ext_cc += "'"+path.join("src",nativeModule.name,file.substr(nativeModule.sources.length-1, file.length-nativeModule.sources.length+1))+"',";
                  }
                }
                ext_cc += "'"+path.join("src",nativeModule.name,path.basename(nativeModule.cc))+"',";
                source = source.replace("'src/node_v8.cc',","'src/node_v8.cc',"+ext_cc);
              }
              // add src 
              var src_path = "'src/"+nativeModule.name+"'";
              if(source.indexOf(src_path)==-1){
                source = source.replace("'src,'","'src',"+src_path+",")
              }
              // add libraries
              var libs="";
              if(nativeModule.hasOwnProperty('libraries') && Array.isArray(nativeModule.libraries)){
                for(var i in nativeModule.libraries){
                  libs += "'"+nativeModule.libraries[i]+"',"
                }
                libs = libs.substr(0,libs.length-1)
              }
              var libraries_entity = "'libraries':["+libs+"],"
              if(source.indexOf(libraries_entity)==-1){
                source = source.replace("'defines':",libraries_entity+"\n'defines':");
              }
              fs.writeFileSync(extFile, source, "utf8");
              n();
            }

          ],cb);
              
                    
          // patch node.gyp
             
      },function(){
        next();
      });
      
    },


    /**
     * If an old compiled executable exists in the Release directory, delete it.
     * This lets us see if the build failed by checking the existence of this file later.
     */

    function cleanUpOldExecutable(next) {
      fs.unlink(nodeCompiler.releasePath, function(err) {
        if (err) {
          if (err.code === "ENOENT") {
            next();
          } else {
            throw err;
          }
        } else {
          next();
        }
      });
    },

    /**
     * compile the node application
     */

    function makeExecutable(next) {
      if (isWin) {
        _log("vcbuild [make stage]");
      } else {
        _log("make");
      }
      nodeCompiler.make(next);
    },

    /**
     * we create the output directory if needed
     */

    function makeOutputDirectory(next) {
      mkdirp(path.dirname(options.output), function() {
        next();
      });
    },

    /**
     * Verify that the executable was compiled successfully
     */

    function checkThatExecutableExists(next) {
      fs.exists(nodeCompiler.releasePath, function(exists) {
        if (!exists) {
          _log("error",
            "The release executable has not been generated. " +
            "This indicates a failure in the build process. " +
            "There is likely additional information above."
          );
          process.exit(1);
        } else {
          next();
        }
      });
    },

    function stripBinary(next)
    {
      var cmd = "/usr/bin/strip";
      if(options.hasOwnProperty("stripBinary") &&
         options.stripBinary==true && 
         fs.existsSync(cmd))
      {
        _log("strip binary %s", nodeCompiler.releasePath);
        child_process.execFileSync(cmd, [nodeCompiler.releasePath], []);
        _log('striped');
      }
      next();
    },

    /**
     * Copy the compilied binary to the output specified.
     */

    function copyBinaryToOutput(next) {
      _log("cp %s %s", nodeCompiler.releasePath, options.output);
      ncp(nodeCompiler.releasePath, options.output, function(err) {
        if (err) {
          _log("error", "Couldn't copy binary.");
          throw err; // dump raw error object
        }
        _log('copied');

        next();
      });
    }



  ], complete);
}

/**
 * Download a version of node
 *
 * @param {string} version, version of node to download
 * @param {string} directory, where to store the downloaded src
 * @param {function} complete, callback
 */

function _downloadNode(version, directory, nodeConfigureArgs, nodeMakeArgs, nodeVCBuildArgs, complete) {
  var nodeFileDir = path.resolve(path.join(directory, framework, version)), // fixes #107, was process.cwd(), + rest.
    nodeFilePath = path.resolve(path.join(nodeFileDir, framework + "-" + version + ".tar.gz"));


  // might already be downloaded, and unzipped
  if (_getNodeCompiler(nodeFileDir, nodeConfigureArgs, nodeMakeArgs, nodeVCBuildArgs, complete)) {
    return;
  }


  async.waterfall([

    /**
     * first make the directory where the zip file will live
     */

    function makeDirectory(next) {
      mkdirp.sync(path.dirname(nodeFilePath));
      next();
    },

    /**
     * download node into the target directory
     */

    function downloadNode(next) {
      if (fs.existsSync(nodeFilePath)) return next();

      var uri = framework;

      if (framework === "node") {
        uri = 'nodejs'; // if node, use nodejs uri
      } else if (framework === 'nodejs') {
        framework = 'node'; // support nodejs, and node, as framework.
      }

      var type = global.type;
      var url, prefix = "https://" + uri + ".org/dist";

      if (version === "latest") {
        url = prefix + "/" + framework + "-" + version + ".tar.gz";
      } else {
        url = prefix + "/v" + version + "/" + framework + "-v" + version + ".tar.gz";
      }

      _log("downloading %s", url);

      var output = fs.createWriteStream(nodeFilePath, {
        "flags": "w+"
      });

      // need to set user-agent to bypass some corporate firewalls
      var requestOptions = {
        url: url,
        headers: {
          "User-Agent": "Node.js"
        }
      }

      _logProgress(request(requestOptions)).pipe(output);

      output.on("close", function() {
        next();
      });
    },

    /**
     * unzip in the same directory
     */

    function unzipNodeTarball(next) {
      var onError = function(err) {
        console.log(err.stack);
        _log("error", "failed to extract the node source");
        process.exit(1);
      }

      if (isWin) {
        _log("extracting the node source [node-tar.gz]");

        // tar-stream method w/ gunzip-maybe
        var read = fs.createReadStream(nodeFilePath);
        var extract = tarstream.extract()
        var basedir = nodeFileDir;

        if (!fs.existsSync(nodeFileDir)) {
          fs.mkdirSync(nodeFileDir);
        }

        extract.on('entry', function(header, stream, callback) {
          // header is the tar header
          // stream is the content body (might be an empty stream)
          // call next when you are done with this entry

          var absolutepath = path.join(basedir, header.name);
          if (header.type === 'directory') {
            // handle directories.
            // console.log('dir:', header.name);
            fs.mkdirSync(absolutepath);
            return callback();
          } else if (header.type === 'file') {
            // handle files
            // console.log('file:', header.name);
          } else {
            console.log(header.type + ':', header.name);
            _log('warn', 'unhandled type in tar extraction, skipping');
            return callback();
          }

          var write = fs.createWriteStream(absolutepath);

          stream.pipe(write);

          write.on('close', function() {
            return callback();
          });

          stream.on('error', function(err) {
            return onError(err);
          })

          write.on('error', function(err) {
            return onError(err);
          });

          stream.resume() // just auto drain the stream
        })

        extract.on('finish', function() {
          _log('extraction finished');
          return next();
        })

        read.pipe(gunzip()).pipe(extract);
      } else {
        _log("extracting the node source [native tar]");

        var cmd = ["tar", "-xf", nodeFilePath, "-C", nodeFileDir];
        _log(cmd.join(" "));

        var tar = spawn(cmd.shift(), cmd);
        tar.stdout.pipe(process.stdout);
        tar.stderr.pipe(process.stderr);

        tar.on("close", function() {
          return next();
        });
        tar.on("error", onError);
      }
    },

    /**
     * return the compiler object for the node version
     */

    function(next, type) {
      _getNodeCompiler(nodeFileDir, nodeConfigureArgs, nodeMakeArgs, nodeVCBuildArgs, next, type)
    },

  ], complete);
}

/**
 * Get the compilier we will use for whatever platform we may be on and configure
 * it.
 */

function _getNodeCompiler(nodeFileDir, nodeConfigureArgs, nodeMakeArgs, nodeVCBuildArgs, complete, type) {
  var dir = _getFirstDirectory(nodeFileDir);

  // standard
  var executable = "node.exe";
  var binary = "node";

  // iojs specifics.
  if (framework === "iojs") {
    executable = "iojs.exe";
    binary = "iojs";
  }

  if (dir) {
    if (isWin) {
      complete(null, {
        dir: dir,
        version: path.basename(nodeFileDir),
        releasePath: path.join(dir, "Release", executable),
        make: function(next) {
          // create a new env with minimal impact on old one
          var newEnv = process.env

          if (isPy !== "python") {
            // add the dir of the suposed python exe to path
            newEnv.path = process.env.PATH + ";" + path.dirname(isPy)
          }

          if (!nodeVCBuildArgs || !nodeVCBuildArgs.length) {
            nodeVCBuildArgs = [ "nosign" ]; // "release" is already the default config value in VCBuild.bat
          }
          
          // spawn a vcbuild process with our custom enviroment.
          var vcbuild = spawn("vcbuild.bat", nodeVCBuildArgs, {
            cwd: dir,
            env: newEnv
          });
          vcbuild.stdout.pipe(process.stdout);
          vcbuild.stderr.pipe(process.stderr);
          vcbuild.on("close", function() {
            next();
          });
        }
      });
    } else {
      complete(null, {
        dir: dir,
        version: path.basename(nodeFileDir),
        releasePath: path.join(dir, "out", "Release", binary),
        make: function(next) {
          var cfg = "./configure",
            configure;

          var conf = [cfg];

          if (isPy !== "python") {
            conf = [conf].concat(nodeConfigureArgs);
          }

          // should work for all use cases now.
          configure = spawn(isPy, conf, {
            cwd: dir.toString('ascii')
          });

          // local function, move to top eventually
          function _loop(dir) {
            /* eventually try every python file */
            var pdir = fs.readdirSync(dir);

            pdir.forEach(function(v, i) {
              var stat = fs.statSync(dir + "/" + v);
              if (stat.isFile()) {
                // only process Makefiles and .mk targets.
                if (v !== "Makefile" && path.extname(v) !== ".mk") {
                  return;
                }

                _log("patching " + v);

                /* patch the file */
                var py = fs.readFileSync(dir + "/" + v, {
                  encoding: 'utf8'
                });
                py = py.replace(/([a-z]|\/)*python(\w|)/gm, isPy); // this is definently needed
                fs.writeFileSync(dir + "/" + v, py, {
                  encoding: 'utf8'
                }); // write to file

              } else if (stat.isDirectory()) {
                // must be dir?
                // skip tests because we don't need them here
                if (v !== "test") {
                  _loop(dir + "/" + v)
                }
              }
            });
          }

          configure.stdout.pipe(process.stdout);
          configure.stderr.pipe(process.stderr);

          // on error
          configure.on("error", function(err) {
            console.log('Error:', err);
            console.log('');
            console.log('Details:');
            console.log('command =', isPy, cfg, conf_args || '');
            console.log('cwd =', dir);

            var configure_path = path.join(dir, 'configure');
            var contains_configure = fs.existsSync(configure_path);

            console.log('cwd contains configure,', (contains_configure ? colors.green('yes') : colors.red('no')));

            var configure_size = fs.statSync(configure_path).size;

            console.log('configure is non-zero size,', ((configure_size > 0) ? colors.green('yes') : colors.red('no')));

            _log("error", "failed to launch configure.");
            process.exit(1);
          });

          // when it's finished
          configure.on("close", function() {
            if (isPy !== "python") {
              /**
               * Originally I thought this only applied to io.js,
               * however I soon found out this affects node.js,
               * so it is now mainstream.
               */
              _log("preparing python");

              // loop over depends
              _loop(dir);
            }

            if (nodeMakeArgs === undefined) {
              nodeMakeArgs = [];
            }

            var platformMake = "make";
            if (os.platform().match(/bsd$/) != null) {
              platformMake = "gmake";
            }

            var make = spawn(platformMake, nodeMakeArgs, {
              cwd: dir
            });
            make.stdout.pipe(process.stdout);
            make.stderr.pipe(process.stderr);
            make.on("error", function(err) {
              console.log(err);
              _log("error", "failed to run make.");
              process.exit(1);
            })
            make.on("close", function() {
              next();
            });
          })
        }
      });
    }
    return true;
  }

  return false;
}

/**
 */

function _monkeyPatchNodeConfig(compiler, complete) {
  async.waterfall([
    /**
     * monkeypatch the gyp file to include the compiled.js and compiledres.js files
     */
    function(next) {
      _monkeyPatchGyp(compiler, next)
    },

    /**
     * monkeypatch main entry point
     */
    function(next) {
      _monkeyPatchMainJs(compiler, next)
    }
  ], complete);
}

/**
 * patch the gyp file to allow our custom includes
 */

function _monkeyPatchGyp(compiler, complete) {

  var gypPath = path.join(compiler.dir, "node.gyp");

  _monkeypatch(
    gypPath,
    function(content) {
      return ~content.indexOf("compiled.js");
    },
    function(content, next) {
      next(null, content.replace("'lib/fs.js',", "'lib/fs.js', 'lib/compiled.js', 'lib/compiledres.js', "))
    },
    complete
  )
}

/**
 */

function _monkeyPatchMainJs(compiler, complete) {
  var mainPath = path.join(compiler.dir, "src", "node.js");

  if(!fs.existsSync(mainPath)) {
    //_log('warn', 'src/node.js doesn\'t exist. Trying \'lib/internal/bootstrap_node.js\'')
    mainPath = path.join(compiler.dir, "lib/internal", "bootstrap_node.js");
  }  

  _monkeypatch(
    mainPath,
    function(content) {
      return ~content.indexOf("node-compiler");
    },
    function(content, next) {      
      next(null, content.replace(/\(function\(process\) \{/, '\
(function(process) {\n\
  //node-compiler injected \n\
  process._eval = \'require("compiled");\';\n\
  if (process.argv[1] !== "compiled.js") {\n\
    process.argv.splice(1, 0, "compiled.js");\n\
  }\n\
'))
    },
    complete
  );
}

/**
 * Make child_process work.
 */
function _monkeyPatchChildProcess(compiler, complete) {
  var childProcPath = path.join(compiler.dir, "lib", "child_process.js");

  _monkeypatch(
    childProcPath,
    function(content) {
      return ~content.indexOf("--child_process");
    },
    function(content, next) {
      next(null, content.replace(/return spawn\(/, 'args.unshift("compiled.js", "--child_process");\n  return spawn('));
    },
    complete
  );
}

/**
 * Patch node.cc to not check the internal arguments.
 */

function _monkeyPatchMainCc(compiler, complete) {
  let finalContents;

  let mainPath = path.join(compiler.dir, "src", "node.cc");
  let mainC = fs.readFileSync(mainPath, {
    encoding: 'utf8'
  });

  // content split, and original start/end
  let constant_loc = 1;
  let lines = mainC.split('\n');
  let startLine = lines.indexOf('  // TODO use parse opts');
  let endLine = lines.indexOf('  option_end_index = i;'); // pre node 0.11.6 compat
  let isPatched = lines.indexOf('// NEXE_PATCH_IGNOREFLAGS');

  if (isPatched !== -1) {
    _log('already patched node.cc');
    return complete();
  }

  /**
   * This is the new method of passing the args. Tested on node.js 0.12.5
   * and iojs 2.3.1
   **/
  if (endLine === -1 && startLine === -1) { // only if the pre-0.12.5 failed.
    _log("using the after 0.12.5 method of ignoring flags.");

    startLine = lines.indexOf("  while (index < nargs && argv[index][0] == '-') {"); // beginning of the function
    endLine = lines.indexOf('  // Copy remaining arguments.');
    endLine--; // space, then it's at the }

    constant_loc = lines.length + 1;
  } else {
    _log('using 0.10.x > method of ignoring flags');
    lines[endLine] = '  option_end_index = 1;';
  }

  /**
   * This is the method for 5.5.0
   **/
  if (endLine === -1 || startLine === -1) {
    _log("using the after 5.5.0 method of ignoring flags.");

    startLine = lines.indexOf("  while (index < nargs && argv[index][0] == '-' && !short_circuit) {"); // beginning of the function
    endLine = lines.indexOf('  // Copy remaining arguments.');
    endLine--; // space, then it's at the }

    constant_loc = lines.length + 1;
  }

  // other versions here.
  if (endLine === -1 || startLine === -1) { // failsafe.
    _log("error", "Failed to find a way to patch node.cc to ignoreFlags");
    _log("startLine =", startLine, '| endLine =', endLine);
    process.exit(1);
  }

  // check if it's been done
  lines[constant_loc] = '// NEXE_PATCH_IGNOREFLAGS';

  for (var i = startLine; i < endLine; i++) {
    lines[i] = undefined; // set the value to undefined so it's skipped by the join
  }

  _log('patched node.cc');

  finalContents = lines.join('\n');

  // write the file contents
  fs.writeFile(mainPath, finalContents, {
    encoding: 'utf8'
  }, function(err) {
    if (err) {
      _log('error', 'failed to write to', mainPath);
      return process.exit(1);
    }

    return complete();
  });
}

/**
 * Patch flags.cc from deps/v8/src to use hard-coded flags.
 * this function is very closely ready to accept custom injection code.
 **/
function _monkeyPatchv8FlagsCc(compiler, options, complete) {
  var mainPath = path.join(compiler.dir, "deps/v8/src", "flags.cc");

  fs.readFile(mainPath, {
    encoding: 'utf8'
  }, function(err, contents) {
    if (err) {
      return _log('error', 'failed to read', mainPath);
    }

    // Super simple injection here. Perhaps make it an array at somepoint?
    var injection = '\
const char* nexevargs = "{{args}}";\n\
int nexevargslen = strlen(nexevargs);\n\
SetFlagsFromString(nexevargs, nexevargslen);\n\
';

    var injectionSplit = injection.split('\n');
    var injectionLength = injectionSplit.length;
    var contentsSplit = contents.split('\n');
    var contentsLength = contentsSplit.length;
    var lastInjectionLine = injectionSplit[injectionLength - 2];

    var lineToInjectAfter = contentsSplit.indexOf('  ComputeFlagListHash();');
    var haveWeInjectedBefore = contentsSplit.indexOf(lastInjectionLine);

    var lineInjectDifference = contentsLength - lineToInjectAfter;

    // support for 0.12.x
    if (lineToInjectAfter === -1) {
      _log('warn', 'Using an expiramental support patch for 0.12.x');
      lineToInjectAfter = contentsSplit.indexOf('#undef FLAG_MODE_DEFINE_IMPLICATIONS');
    }

    // support for 0.10.x
    if (lineToInjectAfter === -1) {
      _log('warn', '0.12.x patch failed. Trying 0.10.0 patch');
      lineToInjectAfter = contentsSplit.indexOf('#define FLAG_MODE_DEFINE_IMPLICATIONS') + 1;
    }

    // this is debug, comment out.
    // _log('v8 injection is', injectionLength, 'newlines long');
    // _log('v8 flags source is', contentsLength, 'newlines long');

    // console.log(finalContents)

    var finalContents,
      dontCombine;

    if (lineToInjectAfter !== -1 && haveWeInjectedBefore === -1) {
      _log('injecting v8/flags.cc');

      // super debug
      // _log('v8 injection determined by', lastInjectionLine);
      // _log('v8 inject after line', lineToInjectAfter);
      // _log('v8 inject needs to shift', lineInjectDifference, 'amount of lines by', injectionLength);

      // compute out the amount of space we'll need in this.
      var startShiftLine = contentsLength - 1; // minus one to make up for 0 arg line.
      var endShiftLine = lineToInjectAfter;
      var injectRoom = injectionLength - 1;

      injectionSplit[0] = injectionSplit[0].replace('{{args}}', options.jsFlags);

      for (var i = startShiftLine; i !== endShiftLine; i--) {
        contentsSplit[i + injectRoom] = contentsSplit[i];
        contentsSplit[i] = '';
      }

      var injectionPos = 0;
      for (var i = 0; i !== injectionLength - 1; i++) {
        contentsSplit[(lineToInjectAfter + 1) + injectionPos] = injectionSplit[injectionPos];
        injectionPos++;
      }
    } else if (lineToInjectAfter !== -1 && haveWeInjectedBefore !== -1) {
      _log('re-injecting v8 args');

      dontCombine = true;
      finalContents = contentsSplit.join('\n');
      finalContents = finalContents.replace(/const char\* nexevargs = "[A-Z\-\_]*";/gi,
        'const char* nexevargs = "' + options.jsFlags + '";');
    } else {
      _log('error', 'failed to find a suitable injection point for v8 args.',
        'File a bug report with the node version and log.');

      _log('lineToInjectAfter=' + lineToInjectAfter, 'haveWeInjectedBefore=' + haveWeInjectedBefore);
      return process.exit(1);
    }

    if (!dontCombine) {
      finalContents = contentsSplit.join('\n');
    }

    // write the file contents
    fs.writeFile(mainPath, finalContents, {
      encoding: 'utf8'
    }, function(err) {
      if (err) {
        _log('error', 'failed to write to', mainPath);
        return process.exit(1);
      }

      return complete();
    })
  });
}

/**
 * Get the first directory of a string.
 */

function _getFirstDirectory(dir) {
  var files = glob.sync(dir + "/*");

  for (var i = files.length; i--;) {
    var file = files[i];
    if (fs.statSync(file).isDirectory()) return file;
  }

  return false;
}

/**
 * Log the progress of a request object.
 */

function _logProgress(req) {

  req.on("response", function(resp) {

    var len = parseInt(resp.headers["content-length"], 10),
      bar = new ProgressBar("[:bar]", {
        complete: "=",
        incomplete: " ",
        total: len,
        width: 100 // just use 100
      });

    req.on("data", function(chunk) {
      bar.tick(chunk.length);
    });
  });

  req.on("error", function(err) {
    console.log(err);
    _log("error", "failed to download node sources,");
    process.exit(1);
  });

  return req;
}

/**
 * Attempt to parse the package.json for nexe information.
 *
 * @param {string} path - path to package.json
 * @param {object} options - fallback options
 *
 * @todo implement options overriding package defaults.
 * @todo make this much less hackily implemented....
 *
 * @return {object} nexe.compile - options object
 **/
exports.package = function(path, options) {
  let _package; // scope

  // check if the file exists
  if (fs.existsSync(path) === false) {
    _log("warn", "no package.json found.");
  } else {
    _package = require(path);
  }

  if(!_package || !_package.compiler) {    
    _log('error', 'trying to use package.json variables, but not setup to do so!');
    process.exit(1);
  }

  // replace ^$ w/ os specific extension on output
  if (isWin) {
    _package.compiler.output = _package.compiler.output.replace(/\^\$/, '.exe') // exe
  } else {
    _package.compiler.output = _package.compiler.output.replace(/\^\$/, '') // none
  }

  // construct the object
  let obj = {
    input: (_package.compiler.input || options.i),
    output: (_package.compiler.output || options.o),
    flags: (_package.compiler.runtime.ignoreFlags || (options.f || false)),
    resourceFiles: (_package.compiler.resourceFiles),
    nodeVersion: (_package.compiler.runtime.version || options.r),
    nodeConfigureArgs: (_package.compiler.runtime.nodeConfigureArgs || []),
    nodeMakeArgs: (_package.compiler.runtime.nodeMakeArgs || []),
    nodeVCBuildArgs: (_package.compiler.runtime.nodeVCBuildArgs || []),
    jsFlags: (_package.compiler.runtime['js-flags'] || options.j),
    python: (_package.compiler.python || options.p),
    debug: (_package.compiler.debug || options.d),
    stripBinary: (_package.compiler.stripBinary || options.s),
    uglify: (_package.compiler.uglify || options.u),
    nodeTempDir: (_package.compiler.temp || options.t),
    framework: (_package.compiler.runtime.framework || options.f),
    native: _package.compiler.native || {}
  }

  // browserify options
  if(_package.compiler.browserify !== undefined) {
    obj.browserifyRequires = (_package.compiler.browserify.requires || []);
    obj.browserifyExcludes = (_package.compiler.browserify.excludes || []);
    obj.browserifyPaths    = (_package.compiler.browserify.paths    || []);
  }

  // TODO: get rid of this crappy code I wrote and make it less painful to read.
  Object.keys(_package.compiler).forEach(function(v, i) {
    if (v !== "runtime" && v !== 'browserify') {
      _log("log", v + " => '" + _package.compiler[v] + "'");
    }
  });

  return obj;
}
