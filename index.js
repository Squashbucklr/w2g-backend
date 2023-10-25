const express = require('express');
// const expressws = require('express-ws'); // required by parent

const path = require('path');
const fs = require('fs');
const randomstring = require('randomstring');
const moment = require('moment');

const cors = require('cors');

const app = express();
 
var expressWs = require('express-ws')(app);

app.enable('strict routing');

let lobbies = {}; // all data
// let connections = {}; // map to lobby

async function getAccessData() {
    let json = await new Promise((resolve, reject) => {
        fs.readFile(path.join(__dirname, 'access.json'), 'utf8', (err, data) => {
            if(err) reject(err);
            else resolve(data);
        });
    });
    return JSON.parse(json);
}

function listLobbies() {
    console.log('    There are ' + Object.keys(lobbies).length + ' lobbies active');
}

function setClearLobbyTimeout(lobbyid) {
    clearTimeout(lobbies[lobbyid].expire);
    lobbies[lobbyid].expire = setTimeout(function() {
        if (Object.keys(lobbies[lobbyid].connections).length == 0) {
            console.log('Clearing inactive empty lobby: ' + lobbyid);
            delete lobbies[lobbyid];
            listLobbies();
        }
    }, 5000);
}



app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'page/home.html'));
});

app.use('/lobby', express.static(path.join(__dirname, "frontend")));

app.use('/public', cors(), async function(req, res, next) {
    console.log('Request made to public file:');
    console.log('    at:   ' + moment().format('YYYY-MM-DD HH:mm:ss'));
    console.log('    from: ' + req.ip);
    console.log('    to:   ' + req.path);
    next();
}, express.static(path.join(__dirname, 'public')));

app.use('/private', cors(), async function(req, res, next) {
    console.log('Request made to private file:');
    console.log('    at:   ' + moment().format('YYYY-MM-DD HH:mm:ss'));
    console.log('    from: ' + req.ip);
    console.log('    to:   ' + req.path);

    let accessKey = null;

    if (req.header('Referer') && !accessKey) {
        let parse = /id=([0123456789ABCDEF]+)/.exec(req.header('Referer'));
        if (parse) {
            accessKey = lobbies[parse[1]].elevated;
        }
    }
    if (req.query.key && !accessKey) {
        accessKey = req.query.key;
    }

    if (accessKey) {
        let access = (await getAccessData())[accessKey];
        if (access && access.expires >= (new Date()).valueOf()) {
            // has a valid access key
            let allowed = false;
            console.log(access.allowed, req.path);
            for (let i = 0; i < access.allowed.length; i++) {
                if ((new RegExp(access.allowed[i])).test(req.path)) {
                    allowed = true;
                    break;
                }
            }
            if (allowed) {
                // has access to this route
                console.log('    serving file.');
                next();
                return;
            }
        }
    }

    console.log('    serving 403.');
    res.status(403);
    res.send('403 Forbidden');
}, express.static(path.join(__dirname, 'private')));

// deprecated legacy routes

app.use('/deposed', cors(), async function(req, res, next) {
    console.log('Request made to deprecated deposed route');
    res.redirect('/public' + req.originalUrl.slice(8));
});

app.use('/elevated', cors(), async function(req, res, next) {
    console.log('Request made to deprecated elevated route');
    res.redirect('/private' + req.originalUrl.slice(9));
});

app.get('/startlobby', function(req, res) {
    let lobbyid = randomstring.generate({
        length: 16,
        charset: 'hex',
        capitalization: 'uppercase'
    });

    lobbies[lobbyid] = {
        connections: {},
        url: "",
        subsurl: "",
        play: false,
        time: 0,
        update: moment().valueOf(),
        elevated: "",
        expire: null
    };
    setClearLobbyTimeout(lobbyid);

    console.log('Established a new lobby: ' + lobbyid);
    listLobbies();

    res.redirect('/lobby?id=' + lobbyid);
});

function send(tows, str) {
    if (tows.readyState == 1) {
        tows.send(str);
    }
}

app.ws('/lobby', async function(ws, req) {
    let lobbyid = req.query.id;
    let mpv = req.query.mpv == 'true';
    let connectionid = randomstring.generate({
        length: 16,
        charset: 'hex',
        capitalization: 'uppercase'
    });

    if (lobbies[lobbyid] == undefined) {
        send(ws, JSON.stringify({
            type: "invalid"
        }));
        ws.close();
        return;
    }

    let maxnum = 0;
    let connectionids = Object.keys(lobbies[lobbyid].connections);
    for (let i = 0; i < connectionids.length; i++) {
        let connection = lobbies[lobbyid].connections[connectionids[i]];
        maxnum = Math.max(maxnum, connection.number); 
    }

    lobbies[lobbyid].connections[connectionid] = {
        ws: ws,
        username: connectionid,
        number: maxnum + 1,
        ready: false,
        bypass: false,
        host: false,
        mpv: mpv,
        mpvctrl: false
    }; 

    console.log('User ' + connectionid + ' has connected to lobby ' + lobbyid);
    if (mpv) console.log('    this user is an mpv user');
    computeHost(lobbyid);
    sendToAll(lobbyid, sendConnections);
    sendVideo(lobbyid, connectionid);
    sendElevated(lobbyid, connectionid);

    ws.on('close', function() {
        let username = lobbies[lobbyid].connections[connectionid].username;
        console.log('User ' + username + ' has disconnected from lobby ' + lobbyid);
        delete lobbies[lobbyid].connections[connectionid]; 
        setClearLobbyTimeout(lobbyid);
        computeHost(lobbyid);
        sendToAll(lobbyid, sendConnections);
    });


    ws.on('message', async function(msg) {
        let data = JSON.parse(msg);
        console.log(data);
        switch (data.type) {
            case "ping":
                send(ws, JSON.stringify({
                    type: "pong"
                }));
                break;
            case 'play':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    lobbies[lobbyid].play = data.play;
                }
            case 'time':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    lobbies[lobbyid].time = data.time;
                    lobbies[lobbyid].update = moment().valueOf();
                    sendToAll(lobbyid, sendVideo);
                }
                break;
            case 'elevate':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    console.log('elevate', data.code);
                    lobbies[lobbyid].elevated = data.code;
                    sendToAll(lobbyid, sendElevated)
                }
                break;
            case 'url':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    lobbies[lobbyid].url = data.url;
                    lobbies[lobbyid].time = 0;
                    lobbies[lobbyid].play = false;
                    lobbies[lobbyid].update = moment().valueOf();
                    sendToAll(lobbyid, sendVideo);
                }
                break;
            case 'getvideo':
                sendVideo(lobbyid, connectionid, true);
                break;
            case 'message':
                if (data.message.length > 300) return;
                console.log(data.message);
                for (m in data.message.split(' ')) {
                    if (m.length > 30) return;
                }
                sendToAll(lobbyid, sendMessage(data.message, connectionid))
                break;
            case 'name':
                if (data.name.length > 25 || data.name.length < 1) return;
                console.log(lobbies[lobbyid].connections[connectionid].username + ' (' + connectionid + ') has renamed themselves to ' + data.name);
                lobbies[lobbyid].connections[connectionid].username = data.name; 
                sendToAll(lobbyid, sendConnections);
                break;
            case 'host':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    if (data.connectionid == connectionid) break;
                    let connectionids = Object.keys(lobbies[lobbyid].connections);
                    let minnum = lobbies[lobbyid].connections[connectionids[0]].number;
                    for (let i = 0; i < connectionids.length; i++) {
                        let connection = lobbies[lobbyid].connections[connectionids[i]];
                        minnum = Math.min(minnum, connection.number); 
                    }
                    lobbies[lobbyid].connections[data.connectionid].number = minnum - 1;
                    computeHost(lobbyid);
                    sendToAll(lobbyid, sendConnections);
                } 
                break;
            case 'mpvctrl':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    if (lobbies[lobbyid].connections[data.connectionid].mpv) {
                        if (lobbies[lobbyid].connections[data.connectionid].mpvctrl) {
                            lobbies[lobbyid].connections[data.connectionid].mpvctrl = false;
                        } else {
                            let connectionids = Object.keys(lobbies[lobbyid].connections);
                            for (let i = 0; i < connectionids.length; i++) {
                                lobbies[lobbyid].connections[connectionids[i]].mpvctrl = false;
                            }
                            lobbies[lobbyid].connections[data.connectionid].mpvctrl = true;
                        }
                        sendConnections(lobbyid, connectionid);
                    } 
                } 
                break;
            case 'mpv':
                if (lobbies[lobbyid].connections[connectionid].host) {
                    switch (data.command) {
                        case 'display':
                            sendToAll(lobbyid, getSendMpvMessage('display'));
                            break;
                        case 'subcycle':
                            sendToAll(lobbyid, getSendMpvMessage('subcycle'));
                            break;
                        case 'audiocycle':
                            sendToAll(lobbyid, getSendMpvMessage('audiocycle'));
                            break;
                        case 'voldown':
                            sendToAll(lobbyid, getSendMpvMessage('voldown'));
                            break;
                        case 'volup':
                            sendToAll(lobbyid, getSendMpvMessage('volup'));
                            break;
                        case 'subdelaydown':
                            sendToAll(lobbyid, getSendMpvMessage('subdelaydown'));
                            break;
                        case 'subdelayup':
                            sendToAll(lobbyid, getSendMpvMessage('subdelayup'));
                            break;
                        case 'audiodelaydown':
                            sendToAll(lobbyid, getSendMpvMessage('audiodelaydown'));
                            break;
                        case 'audiodelayup':
                            sendToAll(lobbyid, getSendMpvMessage('audiodelayup'));
                            break;
                        default:
                            console.log('Invalid mpv command sent by:', connectionid);
                    }
                }
                break;
            default:
                console.log('Invalid command sent by:', connectionid);
                console.log('    data:', data);
                break;
        }
    }); 
});

function sendToAll(lobbyid, sendFunction) {
    let connectionids = Object.keys(lobbies[lobbyid].connections);
    for (let i = 0; i < connectionids.length; i++) {
        sendFunction(lobbyid, connectionids[i]);
    }
}

function computeHost(lobbyid) {
    let connectionids = Object.keys(lobbies[lobbyid].connections);
    if(connectionids.length <= 0) return;
    let hasmin = false;
    let minnumber = lobbies[lobbyid].connections[connectionids[0]].number;
    let minid = connectionids[0];
    for (let i = 0; i < connectionids.length; i++) {
        if (!hasmin || minnumber > lobbies[lobbyid].connections[connectionids[i]].number) {
            minnumber = lobbies[lobbyid].connections[connectionids[i]].number;
            minid = connectionids[i];
        }
        if (!lobbies[lobbyid].connections[connectionids[i]].mpv) hasmin = true;
        lobbies[lobbyid].connections[connectionids[i]].host = false;
    }
    if (hasmin) {
        console.log(minid + ' is the host of lobby ' + lobbyid);
        lobbies[lobbyid].connections[minid].host = true;
    }
}

function getSendMpvMessage(command) {
    return (lobbyid, connectionid) => {
        if (lobbies[lobbyid].connections[connectionid].mpv &&
            lobbies[lobbyid].connections[connectionid].mpvctrl) {
            send(lobbies[lobbyid].connections[connectionid].ws, JSON.stringify({
                type: 'mpv',
                command: command
            }));
        }
    }
}

function sendConnections(lobbyid, connectionid) {
    let sendconnections = {};
    let connectionids = Object.keys(lobbies[lobbyid].connections);
    for (let i = 0; i < connectionids.length; i++) {
        let mpvctrl = lobbies[lobbyid].connections[connectionids[i]].mpvctrl;
        if (!lobbies[lobbyid].connections[connectionid].host) mpvctrl = false;
        sendconnections[connectionids[i]] = {
           username: lobbies[lobbyid].connections[connectionids[i]].username, 
           ready: lobbies[lobbyid].connections[connectionids[i]].ready,
           bypass: lobbies[lobbyid].connections[connectionids[i]].bypass,
           host: lobbies[lobbyid].connections[connectionids[i]].host,
           mpv: lobbies[lobbyid].connections[connectionids[i]].mpv,
           mpvctrl: mpvctrl
        };
    }
    send(lobbies[lobbyid].connections[connectionid].ws, JSON.stringify({
        type: 'connections',
        host: lobbies[lobbyid].connections[connectionid].host,
        connectionid: connectionid,
        connections: sendconnections
    }));
}

async function sendElevated(lobbyid, connectionid) {
    let elevated = !!(await getAccessData())[lobbies[lobbyid].elevated];
    send(lobbies[lobbyid].connections[connectionid].ws, JSON.stringify({
        type: 'elevated',
        elevated
    })); 
}

function sendVideo(lobbyid, connectionid, extra_ahead) {
    let extra_time = 0;
    if(extra_ahead && lobbies[lobbyid].time > 3 && lobbies[lobbyid].play) extra_time = 0.75;
    let settime = lobbies[lobbyid].time + extra_time;
    if (lobbies[lobbyid].play) {
        let millis = moment().valueOf() - lobbies[lobbyid].update;
        settime += millis / 1000;
    }
    send(lobbies[lobbyid].connections[connectionid].ws, JSON.stringify({
        type: 'video',
        video: {
            url: lobbies[lobbyid].url,
            subsurl: lobbies[lobbyid].subsurl,
            play: lobbies[lobbyid].play,
            time: settime
        }
    })); 
}

function sendMessage(message, sourceconnectionid) {
    return function(lobbyid, connectionid) {
        send(lobbies[lobbyid].connections[connectionid].ws, JSON.stringify({
            type: 'message',
            from: lobbies[lobbyid].connections[sourceconnectionid].username,
            message
        }));
    }
}

app.listen(3434);
