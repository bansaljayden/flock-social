import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { getDMs, sendDM as apiSendDM } from '../../services/api';
import {
  socketSendDm,
  onNewDm,
  dmStartTyping,
  dmStopTyping,
  onDmUserTyping,
  onDmUserStoppedTyping,
} from '../../services/socket';

// Same shape as FlockChatScreen but for 1-on-1 DMs. Server-side, the room
// is derived from the (user1_id, user2_id) pair — no explicit join_dm event.

export default function DMChatScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();
  const { connected } = useSocket();

  const otherUserId = route?.params?.otherUserId;
  const otherUserName = route?.params?.otherUserName || 'DM';

  const [messages, setMessages] = useState([]); // newest first
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const typingTimerRef = useRef(null);

  useEffect(() => {
    if (!otherUserId) return;
    let cancelled = false;
    getDMs(otherUserId)
      .then((data) => {
        if (cancelled) return;
        const msgs = data?.messages || [];
        setMessages([...msgs].reverse());
      })
      .catch((e) => console.warn('getDMs failed:', e.message));
    return () => { cancelled = true; };
  }, [otherUserId]);

  useEffect(() => {
    if (!otherUserId) return;
    const offNew = onNewDm((msg) => {
      // Accept messages either direction
      const involved = (msg?.sender_id === otherUserId && msg?.receiver_id === user?.id)
        || (msg?.sender_id === user?.id && msg?.receiver_id === otherUserId);
      if (!involved) return;
      setMessages((cur) => [msg, ...cur]);
    });
    const offTypingStart = onDmUserTyping((d) => { if (d?.fromUserId === otherUserId) setTyping(true); });
    const offTypingStop = onDmUserStoppedTyping((d) => { if (d?.fromUserId === otherUserId) setTyping(false); });
    return () => {
      offNew && offNew();
      offTypingStart && offTypingStart();
      offTypingStop && offTypingStop();
    };
  }, [otherUserId, user?.id]);

  const handleChangeDraft = (text) => {
    setDraft(text);
    if (!otherUserId) return;
    dmStartTyping(otherUserId);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => dmStopTyping(otherUserId), 2200);
  };

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    dmStopTyping(otherUserId);
    try {
      const tempId = `tmp-${Date.now()}`;
      const optimistic = {
        id: tempId,
        sender_id: user?.id,
        receiver_id: otherUserId,
        content: text,
        message_text: text,
        message_type: 'text',
        created_at: new Date().toISOString(),
        _optimistic: true,
      };
      setMessages((cur) => [optimistic, ...cur]);
      if (connected) {
        socketSendDm(otherUserId, text);
      } else {
        await apiSendDM(otherUserId, text);
      }
    } catch (e) {
      Alert.alert('Send failed', e.message);
    } finally {
      setSending(false);
    }
  }, [draft, sending, otherUserId, user?.id, connected]);

  const renderMessage = ({ item }) => {
    const mine = item.sender_id === user?.id;
    return (
      <View style={[styles.row, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
        <View style={{ maxWidth: '78%' }}>
          <View style={[
            styles.bubble,
            {
              backgroundColor: mine ? colors.teal : colors.msgReceivedBg,
              borderBottomRightRadius: mine ? 4 : 16,
              borderBottomLeftRadius: mine ? 16 : 4,
            },
          ]}>
            <Text style={[typography.body, { color: mine ? 'white' : colors.msgReceivedText }]}>
              {item.content || item.message_text}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top', 'bottom']}>
      <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default, borderBottomColor: colors.borderSubtle }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[typography.heading4, { color: colors.textPrimary }]} numberOfLines={1}>{otherUserName}</Text>
          {typing && (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>typing…</Text>
          )}
        </View>
        <View style={styles.headerBtn} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <FlatList
          data={messages}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderMessage}
          inverted
          contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
        />

        <View style={[styles.composer, { backgroundColor: colors.bgPrimary, borderTopColor: colors.borderSubtle }]}>
          <TextInput
            value={draft}
            onChangeText={handleChangeDraft}
            placeholder="Message"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[
              styles.composerInput,
              typography.body,
              { backgroundColor: colors.bgInput, color: colors.textPrimary, borderColor: colors.borderDefault, borderRadius: radius.xxl },
            ]}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!draft.trim() || sending}
            style={[styles.sendBtn, { backgroundColor: draft.trim() ? colors.teal : colors.toggleOff }]}
          >
            <Icon name="send" size={18} color="white" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 8, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', marginVertical: 3 },
  bubble: { padding: 10, paddingHorizontal: 14, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 8, gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerInput: {
    flex: 1, maxHeight: 120, minHeight: 40,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1,
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
