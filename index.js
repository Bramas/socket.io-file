"use strict";
const EventEmitter = require('events').EventEmitter;
const util = require('util');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE = 524288;
const MAX_BUFFER_SIZE = 10485760;

const defaultOptions = {
  randomFileName: false
};

function mkdirSyncRecursively(dir, mode) {
    try {
        var result = fs.mkdirSync(dir, mode);
    }
    catch(e) {
        if(e.code === 'ENOENT') {
            mkdirSyncRecursively(path.dirname(dir), mode);  // if does not exists, create all parents recursively
            mkdirSyncRecursively(dir, mode);   // retry
        }
    }
}

function generateRandomFileName(len)
{
    var text = "";
    var charset = "abcdefghijklmnopqrstuvwxyz0123456789";

    for( var i=0; i < len; i++ )
        text += charset.charAt(Math.floor(Math.random() * charset.length));

    return text;
}

function SocketIOFile(socket, options) {
    const self = this;
    const clients = {};
    const files = {};

    this.options = Object.assign(defaultOptions, options);

	  this.socket = socket;
    this.uploadDir = '';

    var sendError = (err) => {
        this.socket.emit('socket.io-file::error', err);
        this.emit('error', err);
    };

    // create upload dir if not exists
    if(this.options.uploadDir) {
        let dir = this.options.uploadDir;

        function createDirectoryIfNotExists(dir) {
            try {
                fs.accessSync(dir, fs.F_OK);
            }
            catch(e) {
                // create directory if not exists
                mkdirSyncRecursively(dir, '0755');
            }
        }

        if(typeof this.options.uploadDir === 'string') {
            createDirectoryIfNotExists(dir);
        }
        else if(typeof this.options.uploadDir === 'object') {
            for(var key in this.options.uploadDir) {
                createDirectoryIfNotExists(this.options.uploadDir[key]);
            }
        }
        else {
            return sendError('options.uploadDir must be string or object array.');
        }

        this.uploadDir = dir;
    }

    this.socket.on('socket.io-file::sync', (data) => {
        clients[data.id] = true;

        this.socket.emit('socket.io-file::sync', {
            done: true
        });
    });

	this.socket.on('socket.io-file::start', (data) => {
        let id = data.id;
        var uploadId = data.uploadId;
	    let fileName = data.name;
        let uploadDir;
        let uploadTo = data.uploadTo;
        let uploadData = data.data;

        if(typeof this.uploadDir === 'object') {
            if(uploadTo && this.uploadDir[uploadTo]) {
                uploadDir = `${this.uploadDir[uploadTo]}`;
            }
            else {
                return sendError('cannot find upload directory: ' + uploadTo);
            }
        }
        else {
            uploadDir = `${this.uploadDir}`;
        }

    		// Create a new Entry in The Files Variable
        const file = {
                id,
                uploadId,
                size: data.size,
                data: '',
                uploaded: 0,
                path: uploadDir,
                abort: false,
                uploadTo,
                uploadData,
                fileName: fileName
            };
    		files[fileName] = file;

    		let stream = 0;

        if(this.options.randomFileName) {
          do {
            file.fileName = generateRandomFileName(10);
          } while(fs.existsSync(`${uploadDir}/${file.fileName}`));
        }
        else {
          try {
              let stat = fs.statSync(`${uploadDir}/${file.fileName}`);

              if(stat.isFile()) {
                  files[fileName].uploaded = stat.size;
                  stream = stat.size / CHUNK_SIZE;
              }
          }
      		// It's a New File
          catch(e) {}
        }


        self.emit('start', data);

        fs.open(`${uploadDir}/${file.fileName}`, 'a', '0755', (err, fd) => {
            if(err) {
                return sendError('cannot find upload directory: ' + err);
            }
            else {
                files[fileName].fd = fd;	 //We store the file handler so we can write to it later

                const streamObj = {
                    id,
                    uploadId,
					          stream,
                    name: fileName,
                    size: files[fileName].size,
          					uploaded: 0,
          					percent: 0
          				};

                this.emit('stream', streamObj);
                socket.emit(`socket.io-file::${id}::${uploadId}::stream`, streamObj);
            }
        });
	});

    this.socket.on('socket.io-file::abort', (data) => {
        let uploadId = data.uploadId;

        for(var key in files) {
            if(files[key].uploadId === uploadId) {
                let fileName = key;

                fs.unlink(`${files[fileName].path}/${file[fileName].fileName}`);
                files[fileName].abort = true;

                this.socket.emit(`socket.io-file::${files[fileName].id}::abort`, {
                    uploadId,
                    name: fileName,
                    size: files[fileName].size
                });

                break;
            }
        }
    });

	this.socket.on('socket.io-file::stream', (data) => {
        let id = data.id;
        let uploadId = data.uploadId;
        let fileName = data.name;
        let file = files[fileName];

        if(file.abort) {
            delete files[fileName];
        }
        else {
            files[fileName].uploaded += data.data.length;
            files[fileName].data += data.data;

            //console.log('Stream received of ' + fileName + ' ( ' + files[fileName].uploaded + ' / ' + files[fileName].size + ')');
            //console.log('Stream received of ' + id+':'+uploadId + ' ( ' + files[fileName].uploaded + ' / ' + files[fileName].size + ')');

            // on fully uploaded
            if(files[fileName].uploaded == files[fileName].size) {
                //console.log("\n========================= Upload Complete: " + id+':'+uploadId + " =========================\n");

                fs.write(file.fd, file.data, null, 'Binary', (err, writen) => {
		    fs.close(file.fd, (err) => {
	            const streamObj = {
       	                stream,
                        id,
                        uploadId,
                        name: fileName,
                        size: file.size,
                        uploaded: file.size,
                        percent: (file.uploaded / file.size) * 100
                    };

                    this.emit('stream', streamObj);
                    this.emit('complete', {
                        id,
                        uploadId,
                        name: file.fileName,
                        size: file.size,
                        path: file.path,
                        uploadTo: file.uploadTo,
                        data: file.uploadData
                    });

                    socket.emit(`socket.io-file::${id}::${uploadId}::stream`, streamObj);
                    socket.emit(`socket.io-file::${id}::${uploadId}::complete`, {
                        id,
                        uploadId,
                        name: fileName,
                        size: file.size,
                        path: file.path,
                        uploadTo: file.uploadTo,
                        data: file.uploadData
                    });

                    delete files[fileName];
		    });
                });
            }
            // on reaches buffer limit
            else if(files[fileName].data.length > MAX_BUFFER_SIZE) {
                fs.write(files[fileName].fd, files[fileName].data, null, 'Binary', (err, writen) => {
                    files[fileName].data = '';		// clear the buffer

                    var stream = files[fileName].uploaded / CHUNK_SIZE;

                    const streamObj = {
                        stream,
                        id,
                        uploadId,
                        name: fileName,
                        size: file.size,
                        uploaded: file.uploaded,
                        percent: (file.uploaded / file.size) * 100
                    };

                    this.emit('stream', streamObj);
                    socket.emit(`socket.io-file::${id}::${uploadId}::stream`, streamObj);
                });
            }
            else {
                var stream = files[fileName].uploaded / CHUNK_SIZE;

                const streamObj = {
                    stream,
                    id,
                    uploadId,
                    name: fileName,
                    size: file.size,
                    uploaded: file.uploaded,
                    percent: (file.uploaded / file.size) * 100
                };

                //console.log('Stream request of ' + id+':'+uploadId + ', stream: ' + stream);

                this.emit('stream', streamObj);
                socket.emit(`socket.io-file::${id}::${uploadId}::stream`, streamObj);
            }
        }

	});
}
util.inherits(SocketIOFile, EventEmitter);

module.exports = SocketIOFile;
