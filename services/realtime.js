/**
 * The socket.io server, for code that runs outside a request (the minute
 * jobs, webhooks). Rooms are named by the raw user id, which is what the app
 * and /park join with `joinRoom`.
 */
let io = null;

function set(server) {
    io = server;
}

function toUser(userId, event, payload) {
    if (!io || !userId) return;
    io.to(String(userId)).emit(event, payload);
}

module.exports = { set, toUser };
