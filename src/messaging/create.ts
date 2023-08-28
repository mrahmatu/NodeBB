import meta from '../meta';
import plugins from '../plugins';
import db from '../database';
import user from '../user';

interface Message {
    content: string;
    timestamp: number;
    fromuid: number;
    roomId: number;
    deleted: number;
    system: number;
    ip:number;
    newSet?: boolean;
    mid?:number;
}

interface data {
    content: string;
    uid:number;
    roomId:number;
    system: number;
    timestamp?:number;
    ip?:number;
}

interface Messaging {
    sendMessage(data: data): Promise<Message | null>;
    checkContent(content: string): Promise<void>;
    isUserInRoom(uid: number, roomId: number): Promise<boolean>;
    isNewSet(uid: number, roomId: number, timestamp: number): Promise<boolean>;
    getMessagesData(mids: number[], uid: number, roomId: number, flag: boolean): Promise<Message[]>;
    addRoomToUsers(roomId: number, uids: number[], timestamp: number): Promise<void>;
    addMessageToUsers(roomId: number, uids: number[], mid: number, timestamp: number): Promise<void>;
    markUnread(uids: number[], roomId: number): Promise<void>;
    notifyUsersInRoom(uid: number, roomId: number, message: Message): void;
    addSystemMessage(content: string, uid: number, roomId: number): Promise<void>;
    addMessage(data: data): Promise<Message>;
}

interface ContentAndLength {
  content: string;
  length: number;
}

export = function (Messaging: Messaging) {
    Messaging.sendMessage = async (data) => {
        await Messaging.checkContent(data.content);
        const inRoom = await Messaging.isUserInRoom(data.uid, data.roomId);
        if (!inRoom) {
            throw new Error('[[error:not-allowed]]');
        }

        return await Messaging.addMessage(data);
    };

    Messaging.checkContent = async (content) => {
        if (!content) {
            throw new Error('[[error:invalid-chat-message]]');
        }

        const maximumChatMessageLength = (meta.configs.maximumChatMessageLength as number) || 1000;
        content = String(content).trim();
        let { length } = content;
        ({ content, length } = await plugins.hooks.fire('filter:messaging.checkContent', { content, length }) as ContentAndLength);
        if (!content) {
            throw new Error('[[error:invalid-chat-message]]');
        }
        if (length > maximumChatMessageLength) {
            throw new Error(`[[error:chat-message-too-long, ${maximumChatMessageLength}]]`);
        }
    };

    Messaging.addMessage = async (data) => {
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const mid = await db.incrObjectField('global', 'nextMid') as number; // Type assertion
        const timestamp = data.timestamp || Date.now();
        let message = {
            content: String(data.content),
            timestamp: timestamp,
            fromuid: data.uid,
            roomId: data.roomId,
            deleted: 0,
            system: data.system || 0,
        } as Message;

        if (data.ip) {
            message.ip = data.ip;
        }

        message = await plugins.hooks.fire('filter:messaging.save', message) as Message; // Type annotation
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        await db.setObject(`message:${mid}`, message);
        const isNewSet = await Messaging.isNewSet(data.uid, data.roomId, timestamp);
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        let uids = await db.getSortedSetRange(`chat:room:${data.roomId}:uids`, 0, -1) as number[];
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        uids = await user.blocks.filterUids(data.uid, uids) as number[];

        await Promise.all([
            Messaging.addRoomToUsers(data.roomId, uids, timestamp),
            Messaging.addMessageToUsers(data.roomId, uids, mid, timestamp),
            Messaging.markUnread(uids.filter(uid => uid !== Number(data.uid)), data.roomId),
        ]);

        const messages = await Messaging.getMessagesData([mid], data.uid, data.roomId, true);
        if (!messages || !messages[0]) {
            return null;
        }

        messages[0].newSet = isNewSet;
        messages[0].mid = mid;
        messages[0].roomId = data.roomId;
        await plugins.hooks.fire('action:messaging.save', { message: messages[0], data: data });
        return messages[0];
    };

    Messaging.addSystemMessage = async (content, uid, roomId) => {
        const message = await Messaging.addMessage({
            content: content,
            uid: uid,
            roomId: roomId,
            system: 1,
        });
        Messaging.notifyUsersInRoom(uid, roomId, message);
    };

    Messaging.addRoomToUsers = async (roomId, uids, timestamp) => {
        if (!uids.length) {
            return;
        }

        const keys = uids.map(uid => `uid:${uid}:chat:rooms`);
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        await db.sortedSetsAdd(keys, timestamp, roomId);
    };

    Messaging.addMessageToUsers = async (roomId, uids, mid, timestamp) => {
        if (!uids.length) {
            return;
        }
        const keys = uids.map(uid => `uid:${uid}:chat:room:${roomId}:mids`);
        // The next line calls a function in a module that has not been updated to TS yet
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        await db.sortedSetsAdd(keys, timestamp, mid);
    };
}


