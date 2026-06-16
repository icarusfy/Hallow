
var cls = require("./lib/class"),
    url = require('url'),
    http = require('http'),
    fs = require('fs'),
    path = require('path'),
    WebSocket = require('ws'),
    Utils = require('./utils'),
    _ = require('underscore'),
    WS = {};

module.exports = WS;

var MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon'
};

var CLIENT_ROOT = path.join(__dirname, '..', '..', 'client');
var SHARED_ROOT = path.join(__dirname, '..', '..', 'shared');

function serveStaticFile(request, response) {
    var pathname = url.parse(request.url).pathname;
    if(pathname === '/') pathname = '/index.html';

    var filePath;
    if(pathname.indexOf('/shared/') === 0) {
        filePath = path.join(SHARED_ROOT, pathname.replace('/shared/', ''));
    } else {
        filePath = path.join(CLIENT_ROOT, pathname);
    }

    // Prevent path traversal outside the allowed roots
    if(filePath.indexOf(CLIENT_ROOT) !== 0 && filePath.indexOf(SHARED_ROOT) !== 0) {
        response.writeHead(403);
        response.end();
        return;
    }

    fs.readFile(filePath, function(err, data) {
        if(err) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
        var ext = path.extname(filePath);
        response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        response.end(data);
    });
}


/**
 * Abstract Server and Connection classes
 */
var Server = cls.Class.extend({
    init: function(port) {
        this.port = port;
    },

    onConnect: function(callback) {
        this.connection_callback = callback;
    },

    onError: function(callback) {
        this.error_callback = callback;
    },

    broadcast: function(message) {
        throw "Not implemented";
    },

    forEachConnection: function(callback) {
        _.each(this._connections, callback);
    },

    addConnection: function(connection) {
        this._connections[connection.id] = connection;
    },

    removeConnection: function(id) {
        delete this._connections[id];
    },

    getConnection: function(id) {
        return this._connections[id];
    }
});


var Connection = cls.Class.extend({
    init: function(id, connection, server) {
        this._connection = connection;
        this._server = server;
        this.id = id;
    },

    onClose: function(callback) {
        this.close_callback = callback;
    },

    listen: function(callback) {
        this.listen_callback = callback;
    },

    broadcast: function(message) {
        throw "Not implemented";
    },

    send: function(message) {
        throw "Not implemented";
    },

    sendUTF8: function(data) {
        throw "Not implemented";
    },

    close: function(logError) {
        if(logError) {
            log.info("Closing connection to "+this._connection_address+". Error: "+logError);
        }
        this._connection.close();
    }
});


/**
 * WebSocketServer using the modern 'ws' package (RFC 6455).
 */
WS.MultiVersionWebsocketServer = Server.extend({
    _connections: {},
    _counter: 0,

    init: function(port) {
        var self = this;

        this._super(port);

        this._httpServer = http.createServer(function(request, response) {
            var path = url.parse(request.url).pathname;

            if(path === '/api/npc-chat') {
                response.setHeader('Access-Control-Allow-Origin', '*');
                response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if(request.method === 'OPTIONS') {
                    response.writeHead(204);
                    response.end();
                    return;
                }

                if(request.method !== 'POST') {
                    response.writeHead(405);
                    response.end();
                    return;
                }

                var body = '';
                request.on('data', function(chunk) { body += chunk; });
                request.on('end', function() {
                    var data;
                    try {
                        data = JSON.parse(body);
                    } catch(e) {
                        response.writeHead(400, {'Content-Type': 'application/json'});
                        response.end(JSON.stringify({ error: 'Invalid JSON' }));
                        return;
                    }

                    var apiKey = process.env.ANTHROPIC_API_KEY;
                    if(!apiKey) {
                        response.writeHead(200, {'Content-Type': 'application/json'});
                        response.end(JSON.stringify({ error: 'no_api_key' }));
                        return;
                    }

                    var persona = (data.persona || "").toString().slice(0, 500);
                    var message = (data.message || "").toString().slice(0, 300);

                    var payload = JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 80,
                        system: persona,
                        messages: [{ role: "user", content: message }]
                    });

                    var https = require('https');
                    var apiReq = https.request({
                        hostname: 'api.anthropic.com',
                        path: '/v1/messages',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01',
                            'Content-Length': Buffer.byteLength(payload)
                        }
                    }, function(apiRes) {
                        var resBody = '';
                        apiRes.on('data', function(chunk) { resBody += chunk; });
                        apiRes.on('end', function() {
                            response.writeHead(200, {'Content-Type': 'application/json'});
                            try {
                                var parsed = JSON.parse(resBody);
                                var text = (parsed.content && parsed.content[0] && parsed.content[0].text) || null;
                                response.end(JSON.stringify({ text: text }));
                            } catch(e) {
                                response.end(JSON.stringify({ error: 'parse_error' }));
                            }
                        });
                    });

                    apiReq.on('error', function(err) {
                        log.error("NPC chat API error: " + err);
                        response.writeHead(200, {'Content-Type': 'application/json'});
                        response.end(JSON.stringify({ error: 'request_failed' }));
                    });

                    apiReq.write(payload);
                    apiReq.end();
                });
                return;
            }

            if(path === '/status' && self.status_callback) {
                response.writeHead(200);
                response.write(self.status_callback());
                response.end();
                return;
            }

            // Serve static client/shared files for everything else
            serveStaticFile(request, response);
            response.end();
        });

        this._wsServer = new WebSocket.Server({ server: this._httpServer });

        this._wsServer.on('connection', function(socket, request) {
            var remoteAddress = request.socket.remoteAddress;
            var c = new WS.Connection(self._createId(), socket, self, remoteAddress);

            if(self.connection_callback) {
                self.connection_callback(c);
            }
            self.addConnection(c);
        });

        this._wsServer.on('error', function(err) {
            if(self.error_callback) {
                self.error_callback(err);
            }
        });

        this._httpServer.listen(port, function() {
            log.info("Server is listening on port "+port);
        });
    },

    _createId: function() {
        return '5' + Utils.random(99) + '' + (this._counter++);
    },

    broadcast: function(message) {
        this.forEachConnection(function(connection) {
            connection.send(message);
        });
    },

    onRequestStatus: function(status_callback) {
        this.status_callback = status_callback;
    }
});


/**
 * Connection wrapper for the 'ws' package
 */
WS.Connection = Connection.extend({
    init: function(id, connection, server, remoteAddress) {
        var self = this;

        this._super(id, connection, server);
        this._connection_address = remoteAddress;
        this.remoteAddress = remoteAddress;

        this._connection.on('message', function(data, isBinary) {
            if(self.listen_callback) {
                var str = isBinary ? data.toString() : data.toString('utf8');
                try {
                    self.listen_callback(JSON.parse(str));
                } catch(e) {
                    if(e instanceof SyntaxError) {
                        self.close("Received message was not valid JSON.");
                    } else {
                        throw e;
                    }
                }
            }
        });

        this._connection.on('close', function() {
            if(self.close_callback) {
                self.close_callback();
            }
            self._server.removeConnection(self.id);
        });

        this._connection.on('error', function(err) {
            log.error("WebSocket error on connection "+self.id+": "+err);
        });
    },

    send: function(message) {
        this.sendUTF8(JSON.stringify(message));
    },

    sendUTF8: function(data) {
        if(this._connection.readyState === WebSocket.OPEN) {
            this._connection.send(data);
        }
    },

    close: function(logError) {
        if(logError) {
            log.info("Closing connection to "+this.remoteAddress+". Error: "+logError);
        }
        this._connection.close();
    }
});
