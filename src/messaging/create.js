"use strict";
const meta = __importStar(require("../meta"));
const plugins = __importStar(require("../plugins"));
const db = __importStar(require("../database"));
const user = __importStar(require("../user"));
function configureMessaging(Messaging) {
    Messaging.sendMessage = (data) => __awaiter(this, void 0, void 0, function* () {
        yield Messaging.checkContent(data.content);
        const inRoom = yield Messaging.isUserInRoom(data.uid, data.roomId);
        if (!inRoom) {
            throw new Error('[[error:not-allowed]]');
        }
        return yield Messaging.addMessage(data);
    });
    Messaging.checkContent = (content) => __awaiter(this, void 0, void 0, function* () {
        if (!content) {
            throw new Error('[[error:invalid-chat-message]]');
        }
        const maximumChatMessageLength = meta.configs.maximumChatMessageLength || 1000;
        content = String(content).trim();
        let { length } = content;
        ({ content, length } = yield plugins.hooks.fire('filter:messaging.checkContent', { content, length }));
        if (!content) {
            throw new Error('[[error:invalid-chat-message]]');
        }
        if (length > maximumChatMessageLength) {
            throw new Error(`[[error:chat-message-too-long, ${maximumChatMessageLength}]]`);
        }
    });
    Messaging.addMessage = (data) => __awaiter(this, void 0, void 0, function* () {
        const mid = yield db.incrObjectField('global', 'nextMid'); // Type assertion
        const timestamp = data.timestamp || Date.now();
        let message = {
            content: String(data.content),
            timestamp: timestamp,
            fromuid: data.uid,
            roomId: data.roomId,
            deleted: 0,
            system: data.system || 0,
            ip: data.ip,
        };
        if (data.ip) {
            message.ip = data.ip;
        }
        message = yield plugins.hooks.fire('filter:messaging.save', message); // Type annotation
        yield db.setObject(`message:${mid}`, message);
        const isNewSet = yield Messaging.isNewSet(data.uid, data.roomId, timestamp);
        let uids = yield db.getSortedSetRange(`chat:room:${data.roomId}:uids`, 0, -1); // Type assertion
        uids = yield user.blocks.filterUids(data.uid, uids);
        yield Promise.all([
            Messaging.addRoomToUsers(data.roomId, uids, timestamp),
            Messaging.addMessageToUsers(data.roomId, uids, mid, timestamp),
            Messaging.markUnread(uids.filter(uid => uid !== String(data.uid)), data.roomId),
        ]);
        const messages = yield Messaging.getMessagesData([mid], data.uid, data.roomId, true);
        if (!messages || !messages[0]) {
            return null;
        }
        messages[0].newSet = isNewSet;
        messages[0].mid = mid;
        messages[0].roomId = data.roomId;
        yield plugins.hooks.fire('action:messaging.save', { message: messages[0], data: data });
        return messages[0];
    });
    Messaging.addSystemMessage = (content, uid, roomId) => __awaiter(this, void 0, void 0, function* () {
        const message = yield Messaging.addMessage({
            content: content,
            uid: uid,
            roomId: roomId,
            system: 1,
        }); // Type assertion
        Messaging.notifyUsersInRoom(uid, roomId, message);
    });
    Messaging.addRoomToUsers = (roomId, uids, timestamp) => __awaiter(this, void 0, void 0, function* () {
        if (!uids.length) {
            return;
        }
        const keys = uids.map(uid => `uid:${uid}:chat:rooms`);
        yield db.sortedSetsAdd(keys, timestamp, roomId);
    });
    Messaging.addMessageToUsers = (roomId, uids, mid, timestamp) => __awaiter(this, void 0, void 0, function* () {
        if (!uids.length) {
            return;
        }
        const keys = uids.map(uid => `uid:${uid}:chat:room:${roomId}:mids`);
        yield db.sortedSetsAdd(keys, timestamp, mid);
    });
}
exports.default = configureMessaging;
