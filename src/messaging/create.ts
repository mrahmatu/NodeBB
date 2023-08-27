import * as meta from '../meta';
import * as plugins from '../plugins';
import * as db from '../database';
import * as user from '../user';

interface Message {
    content: string;
    timestamp: number;
    fromuid: string;
    roomId: string;
    deleted: number;
    system: number;
    ip?: string;
    newSet?: boolean; // Add newSet property
    mid?: string;
}

interface SendMessageData {
    content: string;
    uid: string;
    roomId: string;
    timestamp?: number;
    system?: number;
    ip?: string;
}

interface Messaging {
    sendMessage(data: SendMessageData): Promise<Message | null>;
    checkContent(content: string): Promise<void>;
    isUserInRoom(uid: string, roomId: string): Promise<boolean>;
    isNewSet(uid: string, roomId: string, timestamp: number): Promise<boolean>;
    getMessagesData(mids: string[], uid: string, roomId: string, flag: boolean): Promise<Message[]>;
    addRoomToUsers(roomId: string, uids: string[], timestamp: number): Promise<void>;
    addMessageToUsers(roomId: string, uids: string[], mid: string, timestamp: number): Promise<void>;
    markUnread(uids: string[], roomId: string): Promise<void>;
    notifyUsersInRoom(uid: string, roomId: string, message: Message): void;
    addSystemMessage(content: string, uid: string, roomId: string): Promise<void>;
    addMessage(data: SendMessageData): Promise<Message>;
}

interface MetaConfig {
    maximumChatMessageLength?: number;
}

export default function configureMessaging(Messaging: Messaging) {
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

        const maximumChatMessageLength = meta.config?.maximumChatMessageLength || 1000;
        content = String(content).trim();
        let { length } = content;
        ({ content, length } = await plugins.hooks.fire('filter:messaging.checkContent', { content, length }));
        if (!content) {
            throw new Error('[[error:invalid-chat-message]]');
        }
        if (length > maximumChatMessageLength) {
            throw new Error(`[[error:chat-message-too-long, ${maximumChatMessageLength}]]`);
        }
    };

    Messaging.addMessage = async (data) => {
        const mid = await db.incrObjectField('global', 'nextMid');
        const timestamp = data.timestamp || Date.now();
        let message = {
            content: String(data.content),
            timestamp: timestamp,
            fromuid: data.uid,
            roomId: data.roomId,
            deleted: 0,
            system: data.system || 0,
            ip: data.ip
        };

        if (data.ip) {
            message.ip = data.ip;
        }

        message = await plugins.hooks.fire('filter:messaging.save', message);
        await db.setObject(`message:${mid}`, message);
        const isNewSet = await Messaging.isNewSet(data.uid, data.roomId, timestamp);
        let uids = await db.getSortedSetRange(`chat:room:${data.roomId}:uids`, 0, -1);
        uids = await user.blocks.filterUids(data.uid, uids);

        await Promise.all([
            Messaging.addRoomToUsers(data.roomId, uids, timestamp),
            Messaging.addMessageToUsers(data.roomId, uids, mid, timestamp),
            Messaging.markUnread(uids.filter(uid => uid !== String(data.uid)), data.roomId),
        ]);

        const messages = await Messaging.getMessagesData([mid], data.uid, data.roomId, true);
        if (!messages || !messages[0]) {
            return null;
        }

        messages[0].newSet = isNewSet;
        messages[0].mid = mid;
        messages[0].roomId = data.roomId;
        plugins.hooks.fire('action:messaging.save', { message: messages[0], data: data });
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
        await db.sortedSetsAdd(keys, timestamp, roomId);
    };

    Messaging.addMessageToUsers = async (roomId, uids, mid, timestamp) => {
        if (!uids.length) {
            return;
        }
        const keys = uids.map(uid => `uid:${uid}:chat:room:${roomId}:mids`);
        await db.sortedSetsAdd(keys, timestamp, mid);
    };
}
