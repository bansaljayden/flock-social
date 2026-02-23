import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  calculateSubscriptionRevenue,
  calculateTransactionRevenue,
  calculateTotalMonthlyRevenue,
  calculateAnnualRevenue,
  calculateMonthlyProfit,
  calculateRevenuePerVenue,
  calculateBreakEven,
  formatCurrency,
  calculateProfitMargin
} from './lib/finance';
import { getCurrentUser, logout, isLoggedIn } from './services/api';
import LoginScreen from './components/auth/LoginScreen';
import SignupScreen from './components/auth/SignupScreen';

// Brand Colors
const colors = {
  navy: '#0d2847',
  navyLight: '#1a3a5c',
  navyMid: '#2d5a87',
  skyBlue: '#4a7ba7',
  cream: '#f5f0e6',
  creamDark: '#e8e0d0',
  teal: '#14B8A6',
  amber: '#F59E0B',
  red: '#EF4444',
  food: '#F97316',
  nightlife: '#1a3a5c',
  music: '#2d5a87',
  sports: '#22C55E',
};

// Shared styles
const styles = {
  phoneContainer: {
    width: '375px',
    maxWidth: '375px',
    height: '100vh',
    maxHeight: '812px',
    margin: '20px auto',
    borderRadius: '44px',
    border: `6px solid ${colors.navy}`,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'white',
    boxShadow: '0 25px 80px -12px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(13,40,71,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
    position: 'relative',
  },
  notch: {
    height: '28px',
    backgroundColor: colors.navy,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  notchInner: {
    width: '120px',
    height: '24px',
    backgroundColor: 'black',
    borderRadius: '20px',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  bottomNav: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '8px 4px',
    backgroundColor: 'white',
    borderTop: `1px solid ${colors.creamDark}`,
    flexShrink: 0,
  },
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    padding: '6px 12px',
    borderRadius: '12px',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'transparent',
  },
  gradientButton: {
    background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
    color: 'white',
    border: 'none',
    borderRadius: '14px',
    padding: '14px 24px',
    fontWeight: '700',
    fontSize: '14px',
    cursor: 'pointer',
    width: '100%',
    boxShadow: '0 4px 15px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
    transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
    letterSpacing: '0.3px',
    position: 'relative',
    overflow: 'hidden',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: '18px',
    padding: '16px',
    marginBottom: '12px',
    boxShadow: '0 4px 24px rgba(13,40,71,0.08), 0 1px 3px rgba(0,0,0,0.04)',
    border: '1px solid rgba(255,255,255,0.9)',
    transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: '14px',
    border: `2px solid ${colors.creamDark}`,
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
    backgroundColor: 'rgba(255,255,255,0.95)',
    fontWeight: '500',
  },
};

const FlockAppInner = () => {
  // User Mode Selection
  const [userMode, setUserMode] = useState(() => localStorage.getItem('flockUserMode') || null);
  const [showModeSelection, setShowModeSelection] = useState(!localStorage.getItem('flockUserMode'));

  // Onboarding
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(() => localStorage.getItem('flockOnboardingComplete') === 'true');
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingVibes, setOnboardingVibes] = useState([]);
  const [onboardingAnimating, setOnboardingAnimating] = useState(false);

  // Navigation
  const [currentTab, setCurrentTab] = useState('home');
  const [currentScreen, setCurrentScreen] = useState('main');
  const [selectedFlockId, setSelectedFlockId] = useState(null);
  const [pickingVenueForCreate, setPickingVenueForCreate] = useState(false);
  const [selectedVenueForCreate, setSelectedVenueForCreate] = useState(null);

  // Toast
  const [toast, setToast] = useState(null);
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Loading & Gamification
  const [isLoading, setIsLoading] = useState(false);
  const [userXP, setUserXP] = useState(280);
  const [userLevel, setUserLevel] = useState(3);
  const [streak] = useState(5);

  // Animations
  const [activeTabAnimation, setActiveTabAnimation] = useState(null);
  const [scrollY, setScrollY] = useState(0);
  const [swipeState, setSwipeState] = useState({ id: null, x: 0, startX: 0 });

  const handleScroll = useCallback((e) => {
    setScrollY(e.target.scrollTop);
  }, []);

  // Swipe gesture handlers
  const handleTouchStart = useCallback((id, e) => {
    setSwipeState({ id, x: 0, startX: e.touches[0].clientX });
  }, []);

  const handleTouchMove = useCallback((id, e) => {
    if (swipeState.id !== id) return;
    const diff = e.touches[0].clientX - swipeState.startX;
    if (diff > 0) { // Only allow right swipe
      setSwipeState(prev => ({ ...prev, x: Math.min(diff, 80) }));
    }
  }, [swipeState.id, swipeState.startX]);

  const handleTouchEnd = useCallback((id, message, e) => {
    if (swipeState.id !== id) return;
    if (swipeState.x > 50) {
      // Trigger reply
      setReplyingTo(message);
    }
    setSwipeState({ id: null, x: 0, startX: 0 });
  }, [swipeState.id, swipeState.x]);

  const addXP = useCallback((amount) => {
    setUserXP(prev => {
      const newXP = prev + amount;
      const newLevel = Math.floor(newXP / 100) + 1;
      if (newLevel > userLevel) {
        setUserLevel(newLevel);
        showToast(`🎉 Level Up! Level ${newLevel}!`);
      }
      return newXP;
    });
  }, [userLevel, showToast]);

  // AI Assistant
  const [aiMessages, setAiMessages] = useState([
    { role: 'assistant', text: "Hey! I'm your Flock assistant. I can help you find venues, check crowd levels, and coordinate plans with friends. What can I help you with?" }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [aiTyping, setAiTyping] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);

  // Calendar
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [calendarEvents, setCalendarEvents] = useState([
    { id: 1, title: 'Friday Night Downtown', date: '2025-01-17', time: '9:17 PM', venue: 'Blue Heron Bar', color: colors.navy, members: 4 },
    { id: 2, title: "Sarah's Birthday Extravaganza", date: '2025-01-18', time: '7:45 PM', venue: 'The Bookstore Speakeasy', color: colors.navyMid, members: 7 },
  ]);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventVenue, setNewEventVenue] = useState('');

  // Stories
  const stories = [
    { id: 1, name: 'Alex', avatar: '🎸', hasNew: true },
    { id: 2, name: 'Sarah', avatar: '🎂', hasNew: true },
    { id: 3, name: 'Jordan', avatar: '⚽', hasNew: false },
    { id: 4, name: 'Taylor', avatar: '🍸', hasNew: true },
    { id: 5, name: 'Mike', avatar: '🎮', hasNew: true },
  ];

  // Activity
  const activityFeed = [
    { id: 1, user: 'Alex', action: 'created', target: 'Jazz Night', time: '5m', icon: '🎉' },
    { id: 2, user: 'Jordan', action: 'voted for', target: 'Sports Bar', time: '12m', icon: '🗳️' },
  ];

  // Flocks
  const [flocks, setFlocks] = useState([
    { id: 1, name: "Friday Night Downtown", host: "Alex", members: ['Alex', 'Sam', 'Jordan', 'Taylor'], time: "Tonight 9:17 PM", status: "voting", venue: "Blue Heron Bar", cashPool: { target: 80, collected: 63, perPerson: 20, paid: ['Alex', 'Sam', 'Jordan'] }, votes: [{ venue: "Blue Heron Bar", type: "Cocktail Bar", voters: ['Alex', 'Sam'] }, { venue: "The Bookstore Speakeasy", type: "Hidden Bar", voters: ['Jordan'] }], messages: [{ id: 1, sender: 'Alex', time: '4:47 PM', text: "we're still doing this right?? 🎉", reactions: ['🔥'] }] },
    { id: 2, name: "Sarah's Birthday Extravaganza", host: "Sarah", members: ['Sarah', 'You', 'Mike', 'Emma', 'Jordan', 'Taylor', 'Chris'], time: "Saturday 7:45 PM", status: "confirmed", venue: "The Bookstore Speakeasy", cashPool: { target: 140, collected: 140, perPerson: 20, paid: ['Sarah', 'You', 'Mike', 'Emma', 'Jordan', 'Taylor', 'Chris'] }, votes: [], messages: [{ id: 1, sender: 'Sarah', time: '2:23 PM', text: "omg I'm so excited!! 🎂", reactions: ['❤️', '🎉'] }] },
    { id: 3, name: "Sunday Funday", host: "Chris", members: ['Chris', 'You', 'Dave'], time: "Sunday 3:30 PM", status: "voting", venue: "Porters Pub", cashPool: null, votes: [{ venue: "Porters Pub", type: "Sports Bar", voters: ['Chris', 'Dave'] }], messages: [{ id: 1, sender: 'Chris', time: '11:12 AM', text: "Eagles game!! 🏈 who's in", reactions: [] }] }
  ]);

  // Create Flock form
  const [flockName, setFlockName] = useState('');
  const [flockDate, setFlockDate] = useState('Tonight');
  const [flockTime, setFlockTime] = useState('9 PM');
  const [flockFriends, setFlockFriends] = useState([]);
  const [flockCashPool, setFlockCashPool] = useState(false);
  const [flockAmount, setFlockAmount] = useState(20);
  const [joinCode, setJoinCode] = useState('');

  // Explore
  const [searchText, setSearchText] = useState('');
  const [category, setCategory] = useState('All');
  const [activeVenue, setActiveVenue] = useState(null);
  const [connections, setConnections] = useState([
    { id: 1, name: 'Alex M.', loc: 'The Jazz Room', interests: ['Live Music'], status: 'available', distance: '0.3 mi' },
    { id: 2, name: 'Jordan K.', loc: 'Sports Bar', interests: ['Sports'], status: 'available', distance: '0.5 mi' },
  ]);
  const [showConnectPanel, setShowConnectPanel] = useState(false);

  // Chat
  const [chatInput, setChatInput] = useState('');
  const [showChatPool, setShowChatPool] = useState(false);
  const [chatPoolAmount, setChatPoolAmount] = useState(20);
  const chatEndRef = useRef(null);
  const aiInputRef = useRef(null);
  const [isTyping, setIsTyping] = useState(false);
  const [typingUser, setTypingUser] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [showChatSearch, setShowChatSearch] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [showReactionPicker, setShowReactionPicker] = useState(null);
  const [showVenueShareModal, setShowVenueShareModal] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);
  const [showImagePreview, setShowImagePreview] = useState(false);

  // Direct Messages
  const [directMessages, setDirectMessages] = useState([
    { id: 'dm-1', friendName: 'Alex', avatar: '🎸', messages: [
      { id: 1, sender: 'Alex', text: 'yo you coming out tonight or what', time: '6:34 PM' },
      { id: 2, sender: 'You', text: 'ya for sure! where we thinking', time: '6:37 PM' },
      { id: 3, sender: 'Alex', text: 'Blue Heron? Sarah said shes down', time: '6:38 PM' },
    ], lastActive: '3m ago', isOnline: true, unread: 2 },
    { id: 'dm-2', friendName: 'Sarah', avatar: '🎂', messages: [
      { id: 1, sender: 'Sarah', text: 'thanks for the bday wishes!! 🎉', time: '2:13 PM' },
      { id: 2, sender: 'You', text: 'ofc!! cant wait for saturday', time: '2:27 PM' },
    ], lastActive: '47m ago', isOnline: false, unread: 0 },
  ]);
  const [selectedDmId, setSelectedDmId] = useState(null);
  const [showNewDmModal, setShowNewDmModal] = useState(false);
  const [dmSearchText, setDmSearchText] = useState('');

  // Profile
  const [profileScreen, setProfileScreen] = useState('main');
  const [profileName, setProfileName] = useState('Jayden');
  const [profileHandle, setProfileHandle] = useState('jayden');
  const [profileBio, setProfileBio] = useState('Love exploring new places!');
  const [profilePic, setProfilePic] = useState(null);
  const [showPicModal, setShowPicModal] = useState(false);
  const [trustedContacts, setTrustedContacts] = useState(['Mom', 'Dad']);
  const [newContactName, setNewContactName] = useState('');
  const [safetyOn, setSafetyOn] = useState(true);

  // Interests
  const [userInterests, setUserInterests] = useState(['Live Music', 'Cocktails', 'Nightlife']);
  const [newInterest, setNewInterest] = useState('');
  const suggestedInterests = ['Sports', 'Food', 'Dancing', 'Karaoke', 'Comedy', 'Art', 'Wine', 'Beer', 'Trivia', 'Pool', 'Darts', 'Gaming'];

  // Payment Methods
  const [paymentMethods, setPaymentMethods] = useState([
    { id: 1, brand: 'Visa', last4: '4242', expiry: '12/26', isDefault: true },
  ]);
  const [showAddCard, setShowAddCard] = useState(false);
  const [newCard, setNewCard] = useState({ number: '', expiry: '', cvv: '', name: '' });

  // Modals
  const [showSOS, setShowSOS] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);

  // Admin Mode (for Revenue Simulator access)
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');

  // Venue Dashboard (for venue owners)
  const [venueTier, setVenueTier] = useState('free'); // 'free', 'premium', 'pro'
  const [venueTab, setVenueTab] = useState('analytics'); // Lifted to App level to persist across re-renders
  const [adminTab, setAdminTab] = useState('revenue'); // Lifted to App level to persist across re-renders

  // Check URL for admin/venue mode on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('admin') === 'true') {
      setCurrentScreen('adminRevenue');
    }
    if (urlParams.get('venue') === 'true') {
      setVenueTier(urlParams.get('tier') || 'free');
      setCurrentScreen('venueDashboard');
    }
  }, []);

  // Focus AI input when modal opens
  useEffect(() => {
    if (showAiAssistant && aiInputRef.current) {
      setTimeout(() => aiInputRef.current?.focus(), 100);
    }
  }, [showAiAssistant]);

  const allFriends = useMemo(() => ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Chris', 'Emma', 'Mike'], []);

  const allVenues = useMemo(() => [
    { id: 1, name: "Apollo Grill", type: "Italian", category: "Food", x: 25, y: 30, crowd: 47, best: "Now-ish", stars: 4.6, addr: '85 W Broad St, Bethlehem', price: '$', trending: false },
    { id: 2, name: "Tulum", type: "Mexican", category: "Food", x: 48, y: 55, crowd: 33, best: "8:47 PM", stars: 4.3, addr: '21 E 4th St, Bethlehem', price: '$$', trending: false },
    { id: 3, name: "The Dime", type: "American", category: "Food", x: 70, y: 38, crowd: 62, best: "Right now", stars: 4.1, addr: '27 Bank St, Easton', price: '$$', trending: false },
    { id: 4, name: "Blue Heron Bar", type: "Cocktail Bar", category: "Nightlife", x: 30, y: 45, crowd: 58, best: "8:30ish", stars: 4.7, addr: '123 N 3rd St, Easton', price: '$$', trending: true },
    { id: 5, name: "The Bookstore Speakeasy", type: "Hidden Bar", category: "Nightlife", x: 45, y: 62, crowd: 41, best: "10 PM+", stars: 4.4, addr: '336 Adams St, Bethlehem', price: '$$$', trending: true },
    { id: 6, name: "Rooftop @ The Grand", type: "Lounge", category: "Nightlife", x: 38, y: 28, crowd: 73, best: "Sunset!", stars: 4.8, addr: '45 N 3rd St, Easton', price: '$$$', trending: true },
    { id: 7, name: "Godfrey Daniels", type: "Live Music", category: "Live Music", x: 58, y: 35, crowd: 51, best: "9 PM", stars: 4.7, addr: '7 E 4th St, Bethlehem', price: '$$', trending: false },
    { id: 8, name: "Porters Pub", type: "Sports Bar", category: "Sports", x: 75, y: 25, crowd: 87, best: "Game time!", stars: 4.2, addr: '700 Northampton St, Easton', price: '$$', trending: false },
  ], []);

  const getFilteredVenues = useCallback(() => {
    let venues = category === 'All' ? allVenues : allVenues.filter(v => v.category === category);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      venues = allVenues.filter(v => v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q));
    }
    return venues;
  }, [category, searchText, allVenues]);

  const getSelectedFlock = useCallback(() => flocks.find(f => f.id === selectedFlockId) || flocks[0], [flocks, selectedFlockId]);

  const formatDateStr = (d) => d.toISOString().split('T')[0];
  const getDaysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const getFirstDayOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const getEventsForDate = useCallback((dateStr) => calendarEvents.filter(e => e.date === dateStr), [calendarEvents]);

  const addEventToCalendar = useCallback((title, venue, date, time, color) => {
    setCalendarEvents(prev => [...prev, { id: Date.now(), title, venue, date: typeof date === 'string' ? date : formatDateStr(date), time, color: color || colors.navy, members: 1 }]);
    showToast('Added to calendar!');
  }, [showToast]);

  const addMessageToFlock = useCallback((flockId, message) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, messages: [...f.messages, message] } : f));
  }, []);

  const updateFlockVotes = useCallback((flockId, newVotes) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, votes: newVotes } : f));
  }, []);

  const makePoolPayment = useCallback((flockId) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId && f.cashPool && !f.cashPool.paid.includes('You')) {
        return { ...f, cashPool: { ...f.cashPool, paid: [...f.cashPool.paid, 'You'], collected: f.cashPool.collected + f.cashPool.perPerson } };
      }
      return f;
    }));
    addXP(20);
    showToast('Payment sent!');
  }, [addXP, showToast]);

  // AI Response Generation - Professional but friendly assistant
  const generateAiResponse = useCallback((userMsg, venueList, flockList, friendsList) => {
    const msg = userMsg.toLowerCase();
    const findVenue = (name) => venueList.find(v => v.name.toLowerCase().includes(name.toLowerCase()));
    const busyVenues = venueList.filter(v => v.crowd >= 70).sort((a, b) => b.crowd - a.crowd);
    const quietVenues = venueList.filter(v => v.crowd < 50).sort((a, b) => a.crowd - b.crowd);

    // VENUE QUESTIONS - Busy/Crowded
    if (msg.includes('busy') || msg.includes('crowded') || msg.includes('packed') || msg.includes('crowd') || msg.includes('poppin')) {
      if (busyVenues.length > 0) {
        const busy = busyVenues[0];
        const quiet = quietVenues[0];
        return { text: `${busy.name} is currently at ${busy.crowd}% capacity - quite busy! ${quiet ? `If you'd prefer somewhere quieter, ${quiet.name} is only at ${quiet.crowd}%.` : 'Most other venues have moderate crowds.'}`, confidence: 94 };
      }
      return { text: "Most venues have light crowds right now - you should be able to get in anywhere without a wait.", confidence: 85 };
    }

    // VENUE QUESTIONS - Recommendations
    if (msg.includes('where should') || msg.includes('recommend') || msg.includes('suggestion') || msg.includes('what venue') || msg.includes('where to go') || msg.includes('pick')) {
      const topRated = venueList.filter(v => v.stars >= 4.5).sort((a, b) => b.stars - a.stars)[0];
      const trending = venueList.find(v => v.trending);
      if (trending) {
        return { text: `${trending.name} is trending tonight. ${topRated && topRated.name !== trending.name ? `Alternatively, ${topRated.name} has excellent reviews (${topRated.stars} stars) if you prefer a smaller crowd.` : ''}`, confidence: 91 };
      }
      if (topRated) {
        return { text: `I'd recommend ${topRated.name} - it has a ${topRated.stars}-star rating, currently at ${topRated.crowd}% capacity. Great ${topRated.type} spot.`, confidence: 89 };
      }
    }

    // PLANNING QUESTIONS
    if (msg.includes('plan') || msg.includes('organize') || msg.includes('coordinate') || msg.includes('create') || msg.includes('start a flock') || msg.includes('make a flock') || msg.includes('rally')) {
      const upcomingFlock = flockList.find(f => f.status === 'voting');
      return { text: `Ready to coordinate plans! ${upcomingFlock ? `Note: "${upcomingFlock.name}" still needs votes from your group.` : 'Tap "Start a Flock" to create a new plan and invite friends.'}`, confidence: 95 };
    }

    // FOOD QUESTIONS
    if (msg.includes('food') || msg.includes('eat') || msg.includes('hungry') || msg.includes('restaurant') || msg.includes('pizza') || msg.includes('taco')) {
      const foodVenues = venueList.filter(v => v.category === 'Food').sort((a, b) => b.stars - a.stars);
      if (foodVenues.length > 0) {
        const top = foodVenues[0];
        return { text: `For food, I'd suggest ${top.name} - ${top.stars} stars, ${top.price} price range, currently at ${top.crowd}% capacity.`, confidence: 92 };
      }
    }

    // NIGHTLIFE QUESTIONS
    if (msg.includes('bar') || msg.includes('drink') || msg.includes('nightlife') || msg.includes('club') || msg.includes('party')) {
      const nightlife = venueList.filter(v => v.category === 'Nightlife').sort((a, b) => b.stars - a.stars);
      if (nightlife.length > 0) {
        const top = nightlife[0];
        return { text: `${top.name} is a great option - ${top.stars} stars, currently at ${top.crowd}% capacity. Best time to arrive: ${top.best}.`, confidence: 90 };
      }
    }

    // SPECIFIC VENUE QUESTIONS
    const venueNames = ['blue heron', 'bookstore', 'godfrey', 'apollo', 'tulum', 'dime', 'rooftop', 'porters'];
    for (const name of venueNames) {
      if (msg.includes(name)) {
        const venue = findVenue(name);
        if (venue) {
          const crowdComment = venue.crowd > 70 ? 'Currently very busy.' : venue.crowd > 40 ? 'Moderate crowd.' : 'Light crowd right now.';
          return { text: `${venue.name}: ${crowdComment} (${venue.crowd}% capacity). ${venue.stars} stars. Best time: ${venue.best}. Located at ${venue.addr}.`, confidence: 96 };
        }
      }
    }

    // FRIEND QUESTIONS
    if (msg.includes('friend') || msg.includes('who') || friendsList.some(f => msg.includes(f.toLowerCase()))) {
      const mentionedFriend = friendsList.find(f => msg.includes(f.toLowerCase()));
      if (mentionedFriend) {
        const randomVenue = venueList[Math.floor(Math.random() * venueList.length)];
        return { text: `${mentionedFriend} was last active near ${randomVenue.name}. Would you like to start a flock and invite them?`, confidence: 78 };
      }
      return { text: `Your friends: ${friendsList.slice(0, 3).join(', ')} are available. Would you like to start coordinating plans?`, confidence: 82 };
    }

    // TIME/SCHEDULE QUESTIONS
    if (msg.includes('time') || msg.includes('when') || msg.includes('schedule') || msg.includes('tonight') || msg.includes('best time')) {
      const bestVenue = venueList.find(v => v.best.includes('Now')) || venueList[0];
      return { text: `${bestVenue.name} is ideal right now. Generally, most venues are best between 9-10 PM. Arriving earlier helps avoid wait times.`, confidence: 87 };
    }

    // HELP QUESTIONS
    if (msg.includes('help') || msg.includes('how do') || msg.includes('how does') || msg.includes('what can you')) {
      return { text: "I can help you with:\n\n• Check crowd levels at venues\n• Get venue recommendations\n• Coordinate plans with friends\n• Find the best time to arrive\n• See where friends are\n\nJust ask and I'll assist!", confidence: 100 };
    }

    // GREETING
    if (msg.includes('hi') || msg.includes('hello') || msg.includes('hey') || msg.includes('sup') || msg === 'yo') {
      const greetings = ["Hey there!", "Hello!", "Hi! How can I help?"];
      return { text: `${greetings[Math.floor(Math.random() * greetings.length)]} I can help you find venues, check crowds, or coordinate plans with friends. What would you like to do?`, confidence: 100 };
    }

    // THANKS
    if (msg.includes('thank') || msg.includes('thanks') || msg.includes('awesome') || msg.includes('great') || msg.includes('perfect')) {
      const responses = ["Happy to help!", "You're welcome! Have a great time.", "Glad I could assist!"];
      return { text: responses[Math.floor(Math.random() * responses.length)], confidence: 100 };
    }

    // DEFAULT
    return { text: "I'm not sure I understood that. I can help you with: finding venues, checking crowd levels, and coordinating plans with friends. Try asking \"where should we go?\" or \"how busy is it?\"", confidence: 65 };
  }, []);

  const sendAiMessage = useCallback(() => {
    if (!aiInput.trim()) return;
    const userMessage = aiInput.trim();
    setAiMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setAiInput('');
    setAiTyping(true);
    setTimeout(() => {
      const response = generateAiResponse(userMessage, allVenues, flocks, allFriends);
      setAiMessages(prev => [...prev, { role: 'assistant', text: response.text, confidence: response.confidence }]);
      setAiTyping(false);
      if (aiInputRef.current) aiInputRef.current.focus();
    }, 1200 + Math.random() * 800);
  }, [aiInput, generateAiResponse, allVenues, flocks, allFriends]);

  // Auto-scroll chat to bottom when messages change
  const selectedFlock = flocks.find(f => f.id === selectedFlockId) || flocks[0];
  useEffect(() => {
    if (currentScreen === 'chatDetail' && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedFlock?.messages, currentScreen]);

  // Send chat message callback
  const sendChatMessage = useCallback(() => {
    if (chatInput.trim()) {
      addMessageToFlock(selectedFlockId, { id: Date.now(), sender: 'You', time: 'Now', text: chatInput, reactions: [] });
      setChatInput('');
      addXP(5);
    }
  }, [chatInput, selectedFlockId, addMessageToFlock, addXP]);

  const getCategoryColor = (cat) => {
    switch(cat) {
      case 'Food': return colors.food;
      case 'Nightlife': return colors.nightlife;
      case 'Live Music': return colors.music;
      case 'Sports': return colors.sports;
      default: return colors.navy;
    }
  };

  // Relative time formatter
  const getRelativeTime = (timeStr) => {
    if (timeStr === 'Now') return 'Just now';
    if (timeStr.includes('ago') || timeStr === 'Yesterday') return timeStr;
    const times = { '5m': '5m ago', '10m': '10m ago', '1h': '1h ago', '2h': '2h ago' };
    return times[timeStr] || timeStr;
  };

  // SVG Icon Components
  const Icons = {
    heart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>,
    thumbsUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>,
    flame: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none"><path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.02 5-8 0 2 1 4 3 5 0-3 2-5 4-7 1 1 2 3 2 5 2-1 3-3 3-5 2.87 1.98 5 4.81 5 8 0 4.42-4.03 8-9 8z"/></svg>,
    party: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    mapPin: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>,
    calendar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
    users: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
    shield: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>,
    sparkles: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"></path><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"></path><path d="M19 12l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"></path></svg>,
    dollar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
    vote: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"></path><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7z"></path><path d="M22 19H2"></path></svg>,
    pizza: (color = '#F97316', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 19h20L12 2z"></path><circle cx="12" cy="12" r="1"></circle><circle cx="9" cy="15" r="1"></circle><circle cx="15" cy="15" r="1"></circle></svg>,
    cocktail: (color = '#1a3a5c', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 22h8"></path><path d="M12 11v11"></path><path d="M3 3l18 0-6 8h-6z"></path></svg>,
    music: (color = '#2d5a87', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>,
    sports: (color = '#22C55E', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a15 15 0 0 0 0 20 15 15 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>,
    send: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>,
    mic: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>,
    image: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>,
    search: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>,
    check: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    checkDouble: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 6 9 17 4 12"></polyline><polyline points="22 6 13 17"></polyline></svg>,
    reply: (color = 'currentColor', size = 16) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>,
    compass: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>,
    trendingUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>,
    clock: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
    sun: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>,
    cloud: (color = '#9ca3af', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>,
    home: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
    user: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    wave: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"></path><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"></path><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path></svg>,
    robot: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    logout: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>,
    camera: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>,
    x: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>,
    plus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    minus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    arrowLeft: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>,
    arrowRight: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>,
    bell: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>,
    settings: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
    repeat: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>,
    zap: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>,
    activity: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>,
    building: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"></rect><path d="M9 22v-4h6v4"></path><path d="M8 6h.01"></path><path d="M16 6h.01"></path><path d="M8 10h.01"></path><path d="M16 10h.01"></path><path d="M8 14h.01"></path><path d="M16 14h.01"></path></svg>,
    briefcase: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>,
    creditCard: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>,
    target: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>,
    star: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    starFilled: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    messageSquare: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
    tag: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>,
    gift: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"></polyline><rect x="2" y="7" width="20" height="5"></rect><line x1="12" y1="22" x2="12" y2="7"></line><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path></svg>,
    barChart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>,
    pieChart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>,
    edit: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>,
    trash: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    lock: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>,
    map: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>,
    globe: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>,
    download: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>,
    award: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>,
    checkCircle: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
    alertCircle: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>,
    mail: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>,
    phone: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>,
    upload: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>,
    filter: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>,
    layers: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>,
    eye: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"></path><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>,
    chevronRight: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7"></path></svg>,
    beer: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 11h1a3 3 0 0 1 0 6h-1"></path><path d="M9 12v6"></path><path d="M13 12v6"></path><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2.5 11 2.5s2 .5 3 .5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"></path><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"></path></svg>,
    wine: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 22h8"></path><path d="M12 11v11"></path><path d="M5 3l7 8 7-8"></path><path d="M5 3v5c0 2.4 2.8 5 7 5s7-2.6 7-5V3"></path></svg>,
    laugh: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>,
    gamepad: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="2"></rect></svg>,
    palette: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r="1.5"></circle><circle cx="17.5" cy="10.5" r="1.5"></circle><circle cx="8.5" cy="7.5" r="1.5"></circle><circle cx="6.5" cy="12.5" r="1.5"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"></path></svg>,
    coffee: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"></path><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"></path><line x1="6" y1="2" x2="6" y2="4"></line><line x1="10" y1="2" x2="10" y2="4"></line><line x1="14" y1="2" x2="14" y2="4"></line></svg>,
    partyPopper: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5.8 11.3 2 22l10.7-3.79"></path><path d="M4 3h.01"></path><path d="M22 8h.01"></path><path d="M15 2h.01"></path><path d="M22 20h.01"></path><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12v0c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"></path><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11v0c-.11.7-.72 1.22-1.43 1.22H17"></path><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98v0C9.52 4.9 9 5.52 9 6.23V7"></path><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"></path></svg>,
    externalLink: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>,
    fileText: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>,
  };

  // Add reaction to message
  const addReactionToMessage = useCallback((flockId, messageId, reaction) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId) {
        return {
          ...f,
          messages: f.messages.map(m => {
            if (m.id === messageId) {
              const hasReaction = m.reactions.includes(reaction);
              return { ...m, reactions: hasReaction ? m.reactions.filter(r => r !== reaction) : [...m.reactions, reaction] };
            }
            return m;
          })
        };
      }
      return f;
    }));
    setShowReactionPicker(null);
  }, []);

  // Simulate typing indicator with user name
  const simulateTyping = useCallback((userName) => {
    const names = userName || ['Alex', 'Sam', 'Jordan', 'Taylor'][Math.floor(Math.random() * 4)];
    setTypingUser(names);
    setIsTyping(true);
    setTimeout(() => setIsTyping(false), 2000 + Math.random() * 2000);
  }, []);

  // Share venue to chat
  const shareVenueToChat = useCallback((flockId, venue) => {
    const venueMessage = {
      id: Date.now(),
      sender: 'You',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      text: '',
      reactions: [],
      venueCard: {
        id: venue.id,
        name: venue.name,
        type: venue.type,
        category: venue.category,
        addr: venue.addr,
        stars: venue.stars,
        price: venue.price,
        crowd: venue.crowd,
        best: venue.best
      }
    };
    addMessageToFlock(flockId, venueMessage);
    setShowVenueShareModal(false);
    showToast('Venue shared!');
    addXP(5);
  }, [addMessageToFlock, showToast, addXP]);

  // Share image to chat
  const shareImageToChat = useCallback((flockId) => {
    if (!pendingImage) return;
    const imageMessage = {
      id: Date.now(),
      sender: 'You',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      text: '',
      reactions: [],
      image: pendingImage
    };
    addMessageToFlock(flockId, imageMessage);
    setPendingImage(null);
    setShowImagePreview(false);
    showToast('Image sent!');
    addXP(5);
  }, [pendingImage, addMessageToFlock, showToast, addXP]);

  // Handle image selection
  const handleChatImageSelect = useCallback(() => {
    // Simulate selecting an image (in real app would open file picker)
    const sampleImages = [
      'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=400&h=300&fit=crop',
      'https://images.unsplash.com/photo-1470337458703-46ad1756a187?w=400&h=300&fit=crop',
      'https://images.unsplash.com/photo-1566417713940-fe7c737a9ef2?w=400&h=300&fit=crop',
    ];
    setPendingImage(sampleImages[Math.floor(Math.random() * sampleImages.length)]);
    setShowImagePreview(true);
  }, []);

  const handlePhotoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => { setProfilePic(reader.result); setShowPicModal(false); showToast('Photo uploaded!'); addXP(10); };
      reader.readAsDataURL(file);
    }
  }, [showToast, addXP]);

  const generateAIAvatar = useCallback(() => {
    const styles = ['adventurer', 'avataaars', 'bottts', 'personas', 'pixel-art'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const seed = Math.random().toString(36).substring(7);
    setProfilePic(`https://api.dicebear.com/7.x/${style}/svg?seed=${seed}`);
    setShowPicModal(false);
    showToast('AI Avatar generated!');
    addXP(10);
  }, [showToast, addXP]);

  // Toggle Component
  const Toggle = ({ on, onChange }) => (
    <button onClick={onChange} style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', backgroundColor: on ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background-color 0.2s' }}>
      <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: 'white', position: 'absolute', top: '2px', left: on ? '22px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </button>
  );

  // SVG Icons for navigation
  const NavIcon = ({ id, active }) => {
    const color = active ? colors.navy : '#9ca3af';
    const icons = {
      home: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
      explore: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>,
      calendar: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
      chat: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
      revenue: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
      profile: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    };
    return icons[id] || null;
  };

  // Bottom Navigation (Regular users only - hidden in admin/venue modes)
  const BottomNav = () => {
    // Hide bottom nav for admin and venue modes
    if (userMode === 'admin' || userMode === 'venue') return null;

    const handleTabClick = (tabId) => {
      setActiveTabAnimation(tabId);
      setTimeout(() => setActiveTabAnimation(null), 400);
      setCurrentTab(tabId);
      setCurrentScreen('main');
      setProfileScreen('main');
      setActiveVenue(null);
      setShowConnectPanel(false);
    };

    return (
      <div style={{
        ...styles.bottomNav,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.06)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderTop: '1px solid rgba(0,0,0,0.03)',
        padding: '10px 8px 12px'
      }}>
        {[
          { id: 'home', label: 'Nest' },
          { id: 'explore', label: 'Discover' },
          { id: 'calendar', label: 'Plans' },
          { id: 'chat', label: 'Messages' },
          { id: 'profile', label: 'You' },
        ].map(t => (
          <button key={t.id} onClick={() => handleTabClick(t.id)}
            style={{
              ...styles.navItem,
              backgroundColor: currentTab === t.id ? colors.cream : 'transparent',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              transform: currentTab === t.id ? 'scale(1.05)' : 'scale(1)',
              borderRadius: '14px',
              padding: '8px 14px'
            }}>
            <div className={activeTabAnimation === t.id ? 'tab-bounce' : ''} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'all 0.2s ease' }}>
              <div style={{
                transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                transform: currentTab === t.id ? 'scale(1.1)' : 'scale(1)'
              }}>
                <NavIcon id={t.id} active={currentTab === t.id} />
              </div>
              <span style={{
                fontSize: '10px',
                fontWeight: currentTab === t.id ? '700' : '500',
                color: currentTab === t.id ? colors.navy : '#94a3b8',
                marginTop: '3px',
                transition: 'all 0.2s ease'
              }}>{t.label}</span>
              {currentTab === t.id && (
                <div style={{
                  width: '4px',
                  height: '4px',
                  borderRadius: '2px',
                  backgroundColor: colors.navy,
                  marginTop: '3px',
                  animation: 'scaleBounceIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
                }} />
              )}
            </div>
          </button>
        ))}
      </div>
    );
  };

  // Safety Button - Enhanced with pulse animation
  const SafetyButton = () => safetyOn && currentScreen === 'main' && (
    <button
      onClick={() => setShowSOS(true)}
      style={{
        position: 'absolute',
        bottom: '75px',
        right: '12px',
        width: '52px',
        height: '52px',
        borderRadius: '26px',
        border: 'none',
        background: `linear-gradient(135deg, ${colors.red}, #f97316)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(239,68,68,0.4), 0 2px 6px rgba(0,0,0,0.1)',
        zIndex: 20,
        animation: 'breathe 3s ease-in-out infinite',
        transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
      }}
    >
      {Icons.shield('white', 24)}
    </button>
  );

  // AI Button - Enhanced with floating animation
  const AIButton = () => currentScreen === 'main' && currentTab === 'home' && (
    <button
      onClick={() => setShowAiAssistant(true)}
      style={{
        position: 'absolute',
        bottom: '75px',
        left: '12px',
        width: '52px',
        height: '52px',
        borderRadius: '26px',
        border: 'none',
        background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(13,40,71,0.35), 0 2px 6px rgba(0,0,0,0.1)',
        zIndex: 20,
        animation: 'float 4s ease-in-out infinite',
        transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
      }}
    >
      <div style={{ animation: 'breathe 2s ease-in-out infinite' }}>
        {Icons.robot('white', 24)}
      </div>
    </button>
  );

  // Toast - Enhanced with better animations
  const Toast = () => toast && (
    <div style={{ position: 'fixed', top: '50px', left: '50%', transform: 'translateX(-50%)', zIndex: 60 }}>
      <div
        className="toast-animate"
        style={{
          padding: '14px 28px',
          borderRadius: '28px',
          backgroundColor: toast.type === 'success' ? colors.teal : colors.red,
          color: 'white',
          fontSize: '14px',
          fontWeight: '600',
          boxShadow: toast.type === 'success'
            ? '0 8px 30px rgba(20,184,166,0.35), 0 2px 8px rgba(0,0,0,0.1)'
            : '0 8px 30px rgba(239,68,68,0.35), 0 2px 8px rgba(0,0,0,0.1)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}
      >
        {toast.type === 'success' ? Icons.checkCircle('white', 18) : Icons.alertCircle('white', 18)}
        {toast.message}
      </div>
    </div>
  );


  // SOS Modal
  const SOSModal = () => showSOS && (
    <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.bell(colors.red, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>Emergency</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => { showToast('SOS sent to contacts!'); setShowSOS(false); addXP(30); }} style={{ ...styles.gradientButton, background: `linear-gradient(90deg, ${colors.red}, #f97316)`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.shield('white', 16)} Alert Contacts</button>
          <button onClick={() => { showToast('Location shared!'); setShowSOS(false); }} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.mapPin(colors.navy, 16)} Share Location</button>
          <button onClick={() => setShowSOS(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Check-in Modal
  const CheckinModal = () => showCheckin && (
    <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.check(colors.teal, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>Check-in</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => { showToast('Check-in sent!'); setShowCheckin(false); addXP(30); }} style={{ ...styles.gradientButton, backgroundColor: colors.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.check('white', 16)} I'm Safe</button>
          <button onClick={() => { setShowCheckin(false); setShowSOS(true); }} style={{ ...styles.gradientButton, backgroundColor: colors.red, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.shield('white', 16)} Need Help</button>
          <button onClick={() => setShowCheckin(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Dismiss</button>
        </div>
      </div>
    </div>
  );

  // Profile Pic Modal
  const ProfilePicModal = () => showPicModal && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Profile Picture</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ ...styles.gradientButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'pointer' }}>
            {Icons.camera('white', 16)} Upload Photo
            <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} />
          </label>
          <button onClick={generateAIAvatar} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.robot(colors.navy, 16)} Generate AI Avatar</button>
          <button onClick={() => setShowPicModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Handler for admin password submission
  const handleAdminModeSelect = () => {
    if (adminPassword === 'flock2026') {
      localStorage.setItem('flockUserMode', 'admin');
      setUserMode('admin');
      setShowModeSelection(false);
      setShowAdminPrompt(false);
      setAdminPassword('');
      setCurrentScreen('adminRevenue');
      showToast('Admin access granted');
    } else {
      showToast('Incorrect password', 'error');
      setAdminPassword('');
    }
  };

  // Admin Password Modal - Inline JSX (not a component to prevent focus loss)
  const adminPromptModal = showAdminPrompt && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>
            {Icons.shield(colors.navy, 24)}
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Admin Access</h2>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>Enter password to continue</p>
        </div>
        <input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdminModeSelect()}
          placeholder="Password"
          style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `1px solid ${colors.creamDark}`, fontSize: '14px', marginBottom: '12px', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => { setShowAdminPrompt(false); setAdminPassword(''); }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleAdminModeSelect} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Access</button>
        </div>
      </div>
    </div>
  );

  // New DM Modal - Friend Selector
  const NewDmModal = () => {
    const friendAvatars = { 'Alex': '🎸', 'Sam': '🎮', 'Jordan': '⚽', 'Taylor': '🍸', 'Morgan': '📚', 'Chris': '🎬', 'Emma': '🎨', 'Mike': '🎮' };
    const friendsWithoutDm = allFriends.filter(f => !directMessages.find(dm => dm.friendName === f));
    const filteredFriends = friendsWithoutDm.filter(f => !dmSearchText || f.toLowerCase().includes(dmSearchText.toLowerCase()));

    const startNewDm = (friendName) => {
      const newDm = {
        id: `dm-${Date.now()}`,
        friendName,
        avatar: friendAvatars[friendName] || '👤',
        messages: [],
        lastActive: 'Just now',
        isOnline: Math.random() > 0.5,
        unread: 0
      };
      setDirectMessages(prev => [newDm, ...prev]);
      setSelectedDmId(newDm.id);
      setShowNewDmModal(false);
      setDmSearchText('');
      setCurrentScreen('dmDetail');
    };

    return showNewDmModal && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
        <div style={{ backgroundColor: 'white', borderRadius: '24px 24px 0 0', width: '100%', height: '70%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>New Message</h2>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Select a friend to message</p>
            </div>
            <button onClick={() => { setShowNewDmModal(false); setDmSearchText(''); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: colors.cream, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.x(colors.navy, 16)}
            </button>
          </div>
          <div style={{ padding: '12px' }}>
            <input type="text" value={dmSearchText} onChange={(e) => setDmSearchText(e.target.value)} placeholder="Search friends..." style={{ width: '100%', padding: '12px 16px', borderRadius: '12px', border: `1px solid ${colors.creamDark}`, fontSize: '14px', outline: 'none', boxSizing: 'border-box' }} autoComplete="off" />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
            {filteredFriends.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px', color: '#6b7280' }}>
                <p style={{ fontSize: '13px', margin: 0 }}>{dmSearchText ? 'No friends found' : 'All friends have active chats'}</p>
              </div>
            ) : (
              filteredFriends.map(friend => (
                <button key={friend} onClick={() => startNewDm(friend)} style={{ width: '100%', textAlign: 'left', padding: '12px', borderRadius: '12px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
                  <div style={{ width: '44px', height: '44px', borderRadius: '22px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>
                    {friendAvatars[friend] || '👤'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontSize: '15px', fontWeight: '600', color: colors.navy, margin: 0 }}>{friend}</h3>
                    <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Tap to start chatting</p>
                  </div>
                  <span style={{ fontSize: '16px', color: '#9ca3af' }}>›</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  };

  // DM Detail Screen - Inline JSX to prevent focus loss on input
  const selectedDm = directMessages.find(d => d.id === selectedDmId);

  const sendDmMessage = () => {
    if (!chatInput.trim() || !selectedDm) return;
    const newMsg = { id: Date.now(), sender: 'You', text: chatInput.trim(), time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
    setDirectMessages(prev => prev.map(d => d.id === selectedDmId ? { ...d, messages: [...d.messages, newMsg], lastActive: 'Just now' } : d));
    setChatInput('');
    // Simulate reply
    const friendName = selectedDm.friendName;
    setTimeout(() => {
      const replies = ["Sounds good!", "Yeah for sure!", "Can't wait!", "Haha nice!", "Let's do it!", "See you there!", "Perfect!"];
      const replyMsg = { id: Date.now() + 1, sender: friendName, text: replies[Math.floor(Math.random() * replies.length)], time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
      setDirectMessages(prev => prev.map(d => d.id === selectedDmId ? { ...d, messages: [...d.messages, replyMsg] } : d));
    }, 1500 + Math.random() * 1000);
  };

  const dmDetailScreen = currentScreen === 'dmDetail' && selectedDm && (
    <div key="dm-detail-screen" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
      <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '10px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', flexShrink: 0 }}>
        <button onClick={() => { setCurrentScreen('main'); setChatInput(''); }} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 20)}</button>
        <div style={{ width: '36px', height: '36px', borderRadius: '18px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>{selectedDm.avatar}</div>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontWeight: 'bold', color: 'white', fontSize: '15px', margin: 0 }}>{selectedDm.friendName}</h2>
          <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>{selectedDm.isOnline ? <span style={{ color: '#86EFAC' }}>Online</span> : selectedDm.lastActive}</p>
        </div>
      </div>

      <div onScroll={() => document.activeElement?.blur()} style={{ flex: 1, padding: '16px', overflowY: 'auto', background: `linear-gradient(180deg, ${colors.cream} 0%, rgba(245,240,230,0.8) 100%)` }}>
        {selectedDm.messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' }}>{selectedDm.avatar}</div>
            <h3 style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>Chat with {selectedDm.friendName}</h3>
            <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Say hi to start the conversation!</p>
          </div>
        ) : (
          selectedDm.messages.map((m) => (
            <div key={m.id} style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexDirection: m.sender === 'You' ? 'row-reverse' : 'row' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '16px', background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: m.sender === 'You' ? '11px' : '14px', color: 'white', fontWeight: '700', flexShrink: 0 }}>
                {m.sender === 'You' ? 'Y' : selectedDm.avatar}
              </div>
              <div style={{ maxWidth: '75%' }}>
                <div style={{ borderRadius: '16px', padding: '10px 14px', fontSize: '13px', backgroundColor: m.sender === 'You' ? colors.navy : 'white', color: m.sender === 'You' ? 'white' : colors.navy, borderTopRightRadius: m.sender === 'You' ? '4px' : '16px', borderTopLeftRadius: m.sender === 'You' ? '16px' : '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                  {m.text}
                </div>
                <p style={{ fontSize: '9px', color: '#9ca3af', margin: '4px 4px 0', textAlign: m.sender === 'You' ? 'right' : 'left' }}>{getRelativeTime(m.time)}</p>
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: 'white' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendDmMessage()} placeholder={`Message ${selectedDm.friendName}...`} style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', backgroundColor: '#f3f4f6', border: '1px solid rgba(0,0,0,0.05)', fontSize: '13px', outline: 'none' }} autoComplete="off" />
          <button onClick={sendDmMessage} disabled={!chatInput.trim()} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: chatInput.trim() ? 'linear-gradient(135deg, #4F46E5, #7C3AED)' : '#e5e7eb', color: 'white', cursor: chatInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.send('white', 18)}</button>
        </div>
      </div>
    </div>
  );

  // AI Assistant Modal - Data
  const aiSuggestedQuestions = [
    { text: "Where's poppin rn?", icon: Icons.activity },
    { text: "When should we hit Blue Heron?", icon: Icons.clock },
    { text: "Pick a bar for us", icon: Icons.cocktail },
    { text: "I'm hungry tho", icon: Icons.pizza },
  ];

  const aiQuickActions = [
    { label: 'Scout Spots', icon: Icons.compass, action: () => { setShowAiAssistant(false); setCurrentTab('explore'); } },
    { label: 'Rally the Flock', icon: Icons.users, action: () => { setShowAiAssistant(false); setCurrentScreen('create'); } },
    { label: 'Check Plans', icon: Icons.calendar, action: () => { setShowAiAssistant(false); setCurrentTab('calendar'); } },
  ];

  // AI Assistant Modal - Inline JSX (not a component to prevent focus loss)
  const aiAssistantModal = showAiAssistant && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
        <div style={{ backgroundColor: 'white', borderRadius: '24px 24px 0 0', width: '100%', height: '80%', display: 'flex', flexDirection: 'column' }}>
          {/* Header with animated AI avatar */}
          <div style={{ padding: '12px', borderBottom: '1px solid #eee', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '24px 24px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '20px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}>
                  {Icons.robot('white', 22)}
                </div>
                <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white', animation: 'pulse 2s ease-in-out infinite' }} />
              </div>
              <div>
                <h2 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', margin: 0 }}>Birdie</h2>
                <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {Icons.sparkles('rgba(255,255,255,0.7)', 10)}
                  <span>your personal wingman</span>
                </p>
              </div>
            </div>
            <button onClick={() => setShowAiAssistant(false)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 16)}</button>
          </div>

          {/* Quick Actions */}
          <div style={{ padding: '10px 12px', backgroundColor: '#f9fafb', borderBottom: '1px solid #eee', display: 'flex', gap: '8px' }}>
            {aiQuickActions.map((action, i) => (
              <button key={i} onClick={action.action} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: '1px solid rgba(13,40,71,0.1)', backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                {action.icon(colors.navy, 16)}
                <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{action.label}</span>
              </button>
            ))}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
            {aiMessages.length === 1 && (
              <div style={{ textAlign: 'center', padding: '16px 0', marginBottom: '12px' }}>
                <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(79,70,229,0.3)' }}>
                  {Icons.robot('white', 30)}
                </div>
                <h3 style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How can I help?</h3>
                <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Ask about venues, crowds, or plans.</p>
              </div>
            )}

            {aiMessages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: msg.role === 'user' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
                  {msg.role === 'user' ? Icons.user('white', 14) : Icons.robot('white', 14)}
                </div>
                <div style={{ maxWidth: '78%' }}>
                  <div style={{ borderRadius: '16px', padding: '10px 12px', fontSize: '13px', backgroundColor: msg.role === 'user' ? colors.navy : '#f3f4f6', color: msg.role === 'user' ? 'white' : colors.navy, borderTopRightRadius: msg.role === 'user' ? '4px' : '16px', borderTopLeftRadius: msg.role === 'user' ? '16px' : '4px', boxShadow: msg.role === 'user' ? '0 2px 8px rgba(13,40,71,0.2)' : '0 1px 3px rgba(0,0,0,0.05)' }}>
                    {msg.text}
                  </div>
                  {msg.role === 'assistant' && msg.confidence && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', paddingLeft: '4px' }}>
                      {Icons.activity('#9ca3af', 10)}
                      <span style={{ fontSize: '9px', color: '#9ca3af' }}>{msg.confidence}% confidence</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {aiTyping && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1.5s ease-in-out infinite' }}>
                  {Icons.robot('white', 14)}
                </div>
                <div style={{ backgroundColor: '#f3f4f6', borderRadius: '16px', borderTopLeftRadius: '4px', padding: '12px 16px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#7C3AED', animation: 'bounce 1.4s ease-in-out 0.15s infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out 0.3s infinite' }} />
                </div>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          {aiMessages.length <= 2 && !aiTyping && (
            <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', backgroundColor: '#f9fafb' }}>
              <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Try asking</p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {aiSuggestedQuestions.map((q, i) => (
                  <button key={i} onClick={() => { setAiInput(q.text); }} style={{ padding: '6px 10px', borderRadius: '16px', border: '1px solid rgba(13,40,71,0.15)', backgroundColor: 'white', cursor: 'pointer', fontSize: '11px', color: colors.navy, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {q.icon(colors.navy, 12)}
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: 'white' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input ref={aiInputRef} type="text" value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendAiMessage()} placeholder="Ask me anything..." style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', backgroundColor: '#f3f4f6', border: '1px solid rgba(0,0,0,0.05)', fontSize: '13px', outline: 'none', fontWeight: '500' }} autoComplete="off" />
              <button onClick={sendAiMessage} disabled={!aiInput.trim()} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: aiInput.trim() ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : '#e5e7eb', color: 'white', cursor: aiInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: aiInput.trim() ? '0 4px 12px rgba(13,40,71,0.3)' : 'none', transition: 'all 0.2s' }}>{Icons.send('white', 18)}</button>
            </div>
          </div>
        </div>
      </div>
  );

  // Mode Selection Handler
  const selectMode = (mode) => {
    if (mode === 'admin') {
      setShowAdminPrompt(true);
    } else {
      localStorage.setItem('flockUserMode', mode);
      setUserMode(mode);
      setShowModeSelection(false);
      if (mode === 'venue') {
        setCurrentScreen('venueDashboard');
      }
    }
  };

  const switchMode = () => {
    localStorage.removeItem('flockUserMode');
    setUserMode(null);
    setShowModeSelection(true);
    setCurrentScreen('main');
    setCurrentTab('home');
  };

  // Easter egg - tap counter (state used via callback in setEasterEggTaps)
  // eslint-disable-next-line no-unused-vars
  const [easterEggTaps, setEasterEggTaps] = useState(0);

  // WELCOME SCREEN - Mode Selection
  const WelcomeScreen = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream, padding: '20px', boxSizing: 'border-box' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        {/* Logo */}
        <div
          onClick={() => {
            setEasterEggTaps(prev => {
              const newCount = prev + 1;
              if (newCount === 7) {
                showToast("You found a secret! Welcome to the flock.");
                return 0;
              }
              if (newCount === 5) showToast("Keep tapping...");
              return newCount;
            });
          }}
          style={{ width: '80px', height: '80px', borderRadius: '24px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px', boxShadow: '0 8px 32px rgba(13,40,71,0.3)', cursor: 'pointer' }}
        >
          {Icons.users('white', 40)}
        </div>
        <h1 style={{ fontSize: '28px', fontWeight: '900', color: colors.navy, margin: '0 0 4px', textAlign: 'center' }}>Flock</h1>
        <p style={{ fontSize: '13px', color: colors.navyMid, margin: '0 0 28px', textAlign: 'center', fontWeight: '500' }}>Social Coordination Simplified</p>

        {/* Mode Cards */}
        <div style={{ width: '100%', maxWidth: '320px' }}>
          {/* User Mode */}
          <button onClick={() => selectMode('user')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.users('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>I'm Going Out</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Coordinate with friends, find venues</p>
            </div>
            <span style={{ fontSize: '20px', color: colors.navy }}>›</span>
          </button>

          {/* Venue Owner Mode */}
          <button onClick={() => selectMode('venue')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'linear-gradient(135deg, #7C3AED, #5B21B6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.building('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>Venue Dashboard</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Manage your venue, see traffic</p>
            </div>
            <span style={{ fontSize: '20px', color: colors.navy }}>›</span>
          </button>

          {/* Admin Mode */}
          <button onClick={() => selectMode('admin')} style={{ width: '100%', padding: '20px', borderRadius: '16px', border: 'none', background: 'white', marginBottom: '12px', cursor: 'pointer', textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: '16px', transition: 'transform 0.2s, box-shadow 0.2s' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'linear-gradient(135deg, #059669, #047857)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.briefcase('white', 28)}
            </div>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: '16px', fontWeight: '800', color: colors.navy, margin: '0 0 4px' }}>Admin Dashboard</h3>
              <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>Platform analytics & revenue</p>
            </div>
            <span style={{ fontSize: '9px', color: '#9ca3af', backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px' }}>Locked</span>
          </button>
        </div>
      </div>

      {/* Footer */}
      <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', margin: 0 }}>You can switch modes anytime in your profile</p>
    </div>
  );

  // HOME SCREEN
  const HomeScreen = () => {
    const headerScale = Math.max(1 - scrollY * 0.002, 0.95);

    return (
    <div key="home-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
      {/* Header with Parallax */}
      <div style={{
        padding: '16px',
        paddingBottom: '20px',
        background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
        flexShrink: 0,
        transform: `scale(${headerScale})`,
        transformOrigin: 'top center',
        transition: 'transform 0.1s ease-out'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0, letterSpacing: '0.5px' }}>Good evening</p>
            <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>Hey, {profileName}</h1>
          </div>
          <button onClick={() => setCurrentTab('profile')} style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user('white', 22)}
            </div>
            <span style={{ position: 'absolute', bottom: '-2px', right: '-2px', padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 'bold', color: 'white', backgroundColor: colors.amber }}>L{userLevel}</span>
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ flex: 1.1, borderRadius: '14px', padding: '12px 10px', backgroundColor: 'rgba(255,255,255,0.12)' }}>
            <p style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Active</p>
            <p style={{ fontSize: '22px', fontWeight: '900', color: 'white', margin: '4px 0 0' }}>{flocks.length}</p>
          </div>
          <div style={{ flex: 0.9, borderRadius: '10px', padding: '10px 8px', backgroundColor: 'rgba(255,255,255,0.08)' }}>
            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>Streak</p>
            <p style={{ fontSize: '16px', fontWeight: '800', color: 'white', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.flame('#F59E0B', 16)} {streak}</p>
          </div>
          <div style={{ flex: 1, borderRadius: '12px', padding: '10px', backgroundColor: 'rgba(255,255,255,0.1)' }}>
            <p style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)', margin: 0, textTransform: 'uppercase' }}>XP</p>
            <p style={{ fontSize: '17px', fontWeight: '700', color: 'white', margin: '2px 0 0' }}>{userXP}</p>
            <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '2px', marginTop: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '2px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: '0 0 8px rgba(245,158,11,0.5)' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div onScroll={handleScroll} style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
        {/* Stories */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
          {stories.map(s => (
            <button key={s.id} onClick={() => showToast(`${s.name}'s story`)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
              <div style={{ width: '52px', height: '52px', borderRadius: '26px', padding: '2px', background: s.hasNew ? `linear-gradient(135deg, ${colors.navy}, ${colors.skyBlue})` : '#d1d5db' }}>
                <div style={{ width: '100%', height: '100%', borderRadius: '24px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>{s.avatar}</div>
              </div>
              <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{s.name}</span>
            </button>
          ))}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
          <button
            onClick={() => setCurrentScreen('create')}
            style={{
              flex: 1.2,
              padding: '16px',
              borderRadius: '16px',
              border: 'none',
              background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
              color: 'white',
              fontWeight: '800',
              fontSize: '14px',
              cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            {Icons.plus('white', 16)} Start a Flock
          </button>
          <button
            onClick={() => setCurrentScreen('join')}
            style={{
              flex: 0.8,
              padding: '14px',
              borderRadius: '14px',
              border: `2px solid ${colors.navy}`,
              backgroundColor: 'white',
              color: colors.navy,
              fontWeight: '700',
              fontSize: '13px',
              cursor: 'pointer',
              transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
              boxShadow: '0 2px 8px rgba(13,40,71,0.08)'
            }}
          >
            Join Flock
          </button>
        </div>

        {/* Activity */}
        <div style={styles.card}>
          <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.bell(colors.navy, 14)} Activity</h3>
          {activityFeed.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
              <span>{a.icon}</span>
              <p style={{ fontSize: '11px', flex: 1, margin: 0 }}><span style={{ fontWeight: 'bold' }}>{a.user}</span> {a.action} <span style={{ color: colors.navyMid }}>{a.target}</span></p>
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>{a.time}</span>
            </div>
          ))}
        </div>

        {/* Flocks */}
        <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>Your Flocks</h2>
        {flocks.map((f, idx) => (
          <button key={f.id} className={`card-animate card-animate-${Math.min(idx + 1, 5)}`} onClick={() => { setSelectedFlockId(f.id); setCurrentScreen('detail'); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', padding: idx === 0 ? '18px' : '12px', marginBottom: idx === 0 ? '14px' : '10px', borderLeft: idx === 0 ? `4px solid ${colors.teal}` : 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: idx === 0 ? '10px' : '6px' }}>
              <div>
                <h3 style={{ fontSize: idx === 0 ? '16px' : '14px', fontWeight: idx === 0 ? '800' : 'bold', color: colors.navy, margin: 0 }}>{f.name}</h3>
                <p style={{ fontSize: idx === 0 ? '11px' : '10px', color: '#6b7280', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', idx === 0 ? 12 : 10)} {f.venue}</p>
              </div>
              <span style={{ fontSize: '10px', padding: idx === 0 ? '4px 10px' : '2px 8px', borderRadius: '10px', fontWeight: '600', backgroundColor: f.status === 'voting' ? '#fef3c7' : '#d1fae5', color: f.status === 'voting' ? '#b45309' : '#047857' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>{f.status === 'voting' ? Icons.vote('#b45309', 10) : Icons.check('#047857', 10)} {f.status === 'voting' ? 'Needs Votes' : 'Locked In'}</span>
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex' }}>
                {f.members.slice(0, idx === 0 ? 5 : 4).map((m, j) => (
                  <div key={j} style={{ width: idx === 0 ? '28px' : '24px', height: idx === 0 ? '28px' : '24px', borderRadius: '50%', border: '2px solid white', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: idx === 0 ? '10px' : '9px', fontWeight: 'bold', color: 'white', marginLeft: j > 0 ? '-6px' : 0 }}>{m[0]}</div>
                ))}
                {idx === 0 && f.members.length > 5 && <div style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid white', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: colors.navy, marginLeft: '-6px' }}>+{f.members.length - 5}</div>}
              </div>
              <span style={{ fontSize: idx === 0 ? '11px' : '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', backgroundColor: colors.cream, color: colors.navy }}>{f.time}</span>
            </div>
          </button>
        ))}

        {/* Safety Check-in */}
        <button onClick={() => setShowCheckin(true)} style={{ width: '100%', marginTop: '8px', padding: '14px', borderRadius: '14px', border: `2px dashed ${colors.teal}`, backgroundColor: 'rgba(20,184,166,0.05)', color: colors.teal, fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          {Icons.shield(colors.teal, 16)} Safety Check-in
        </button>
      </div>

      <AIButton />
      <SafetyButton />
      <BottomNav />
    </div>
  );
  };

  // CREATE SCREEN
  const CreateScreen = () => {
    const handleCreate = () => {
      if (!flockName.trim()) { showToast('Enter a plan name', 'error'); return; }
      setIsLoading(true);
      setTimeout(() => {
        const venueName = selectedVenueForCreate?.name || 'TBD';
        const newFlock = { id: Date.now(), name: flockName, host: 'You', members: ['You', ...flockFriends], time: `${flockDate} ${flockTime}`, status: 'voting', venue: venueName, cashPool: flockCashPool ? { target: flockAmount * (flockFriends.length + 1), collected: flockAmount, perPerson: flockAmount, paid: ['You'] } : null, votes: [], messages: [{ id: 1, sender: 'You', time: 'Now', text: `Let's go! 🎉`, reactions: [] }] };
        setFlocks(prev => [...prev, newFlock]);
        addEventToCalendar(flockName, venueName, new Date(), flockTime, colors.navy);
        setFlockName(''); setFlockFriends([]); setFlockCashPool(false); setSelectedVenueForCreate(null);
        setIsLoading(false); setCurrentScreen('main');
        addXP(50); showToast(`"${newFlock.name}" created!`);
      }, 800);
    };

    return (
      <div key="create-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
          <button onClick={() => { setCurrentScreen('main'); setFlockName(''); setFlockFriends([]); setSelectedVenueForCreate(null); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
          <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Start a Flock</h1>
        </div>

        <div style={{ flex: 1, padding: '16px', overflowY: 'auto', backgroundColor: colors.cream }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>What's the plan?</label>
            <input key="flock-name-input" id="flock-name-input" type="text" value={flockName} onChange={(e) => setFlockName(e.target.value)} placeholder="Movie night, dinner, party..." style={styles.input} autoComplete="off" />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>{Icons.mapPin(colors.navy, 12)} Venue</label>
            {selectedVenueForCreate ? (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '8px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{selectedVenueForCreate.category === 'Food' ? Icons.pizza(colors.food, 20) : Icons.cocktail(colors.nightlife, 20)}</div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>{selectedVenueForCreate.name}</p>
                  <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{selectedVenueForCreate.type}</p>
                </div>
                <button onClick={() => setSelectedVenueForCreate(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 16)}</button>
              </div>
            ) : (
              <button onClick={() => { setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.navyMid}`, backgroundColor: 'transparent', color: colors.navy, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.compass(colors.navy, 16)} Pick Venue
              </button>
            )}
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>When</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {['Tonight', 'Tomorrow', 'This Weekend', 'Next Week'].map(d => (
                <button key={d} onClick={() => setFlockDate(d)} style={{ padding: '10px', borderRadius: '8px', border: `2px solid ${flockDate === d ? colors.navy : colors.creamDark}`, backgroundColor: flockDate === d ? colors.navy : 'white', color: flockDate === d ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{d}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Time</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {['7 PM', '8 PM', '9 PM', '10 PM', '11 PM'].map(t => (
                <button key={t} onClick={() => setFlockTime(t)} style={{ padding: '6px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: flockTime === t ? colors.navy : 'white', color: flockTime === t ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Invite ({flockFriends.length})</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {allFriends.map(f => (
                <button key={f} onClick={() => setFlockFriends(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])} style={{ padding: '6px 10px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: flockFriends.includes(f) ? colors.navy : 'white', color: flockFriends.includes(f) ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>
                  {flockFriends.includes(f) ? '✓ ' : ''}{f}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.dollar(colors.navy, 14)} Cash Pool</label>
              <Toggle on={flockCashPool} onChange={() => setFlockCashPool(!flockCashPool)} />
            </div>
            {flockCashPool && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', border: `1px solid ${colors.creamDark}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '500' }}>Per person</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={() => setFlockAmount(prev => Math.max(5, prev - 5))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>−</button>
                    <span style={{ fontSize: '20px', fontWeight: '900', width: '56px', textAlign: 'center', color: colors.navy }}>${flockAmount}</span>
                    <button onClick={() => setFlockAmount(prev => prev + 5)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>+</button>
                  </div>
                </div>
                <p style={{ fontSize: '10px', color: '#6b7280', textAlign: 'center', margin: 0 }}>Total: ${flockAmount * (flockFriends.length + 1)}</p>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={handleCreate} disabled={isLoading} style={{ ...styles.gradientButton, opacity: isLoading ? 0.5 : 1 }}>
            {isLoading ? <><span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>{Icons.activity('white', 16)}</span> Creating...</> : <>{Icons.users('white', 16)} Create Flock</>}
          </button>
        </div>
      </div>
    );
  };

  // JOIN SCREEN
  const JoinScreen = () => (
    <div key="join-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
      <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
        <button onClick={() => { setCurrentScreen('main'); setJoinCode(''); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Join a Flock</h1>
      </div>
      <div style={{ flex: 1, padding: '16px', backgroundColor: colors.cream }}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Enter Code</label>
          <input key="join-code-input" id="join-code-input" type="text" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="ABC123" maxLength={6} style={{ ...styles.input, fontSize: '20px', textAlign: 'center', letterSpacing: '8px', textTransform: 'uppercase' }} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '24px 0' }}>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
          <span style={{ color: '#9ca3af', fontSize: '12px' }}>or</span>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
        </div>
        <button onClick={() => showToast('Camera opening...')} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '500', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{Icons.camera(colors.navy, 16)} Scan QR</button>
      </div>
      <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
        <button onClick={() => { if (joinCode.length === 6) { showToast('Joined successfully!'); addXP(20); setJoinCode(''); setCurrentScreen('main'); } else { showToast('Enter a valid code', 'error'); }}} style={styles.gradientButton}>Join Flock</button>
      </div>
    </div>
  );

  // EXPLORE SCREEN
  // Track clicked/hovered pins for animations
  const [hoveredPin, setHoveredPin] = useState(null);
  const [clickedPin, setClickedPin] = useState(null);

  const ExploreScreen = () => (
    <div key="explore-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#e5e7eb' }}>
      {pickingVenueForCreate && (
        <div style={{ padding: '10px 14px', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, boxShadow: '0 2px 8px rgba(13,40,71,0.3)' }}>
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.mapPin('white', 14)} Tap venue to select</span>
          <button onClick={() => { setPickingVenueForCreate(false); setCurrentScreen('create'); }} style={{ backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '12px', padding: '4px 12px', color: 'white', fontSize: '11px', cursor: 'pointer', fontWeight: '500', transition: 'all 0.2s ease' }}>Cancel</button>
        </div>
      )}

      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: 'white', boxShadow: '0 2px 12px rgba(0,0,0,0.08)', zIndex: 20, flexShrink: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input key="search-input" id="search-input" type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search venues..." style={{ width: '100%', padding: '12px 12px 12px 38px', borderRadius: '14px', backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', fontSize: '13px', outline: 'none', boxSizing: 'border-box', transition: 'all 0.2s ease', fontWeight: '500' }} autoComplete="off" />
          <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', transition: 'all 0.2s ease' }}>{Icons.search('#94a3b8', 16)}</span>
        </div>
        <button onClick={() => setShowConnectPanel(true)} style={{ width: '42px', height: '42px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.users('white', 18)}</button>
      </div>

      {/* Premium Map */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(145deg, #f0f4f0 0%, #e8ece8 50%, #dfe3df 100%)' }}>
          {/* Premium SVG Map with buildings, parks, and roads */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <defs>
              {/* Grid pattern */}
              <pattern id="mapGrid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(0,0,0,0.03)" strokeWidth="1"/>
              </pattern>
              {/* Building shadow gradient */}
              <linearGradient id="buildingShadow" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgba(0,0,0,0.08)"/>
                <stop offset="100%" stopColor="rgba(0,0,0,0)"/>
              </linearGradient>
              {/* Water gradient */}
              <linearGradient id="waterGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#a8d4e6"/>
                <stop offset="50%" stopColor="#7ec8e3"/>
                <stop offset="100%" stopColor="#a8d4e6"/>
              </linearGradient>
              {/* Park gradient */}
              <linearGradient id="parkGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#b8d4a8"/>
                <stop offset="100%" stopColor="#9bc485"/>
              </linearGradient>
              {/* Road gradient */}
              <linearGradient id="roadGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#e5e5e5"/>
                <stop offset="50%" stopColor="#d4d4d4"/>
                <stop offset="100%" stopColor="#e5e5e5"/>
              </linearGradient>
            </defs>

            {/* Base grid */}
            <rect width="100%" height="100%" fill="url(#mapGrid)" />

            {/* Water feature (river/lake) */}
            <ellipse cx="85%" cy="75%" rx="60" ry="80" fill="url(#waterGradient)" opacity="0.7" />
            <ellipse cx="90%" cy="85%" rx="40" ry="50" fill="url(#waterGradient)" opacity="0.6" />

            {/* Parks/green spaces */}
            <rect x="5%" y="10%" width="45" height="55" rx="8" fill="url(#parkGradient)" opacity="0.6" />
            <circle cx="12%" cy="80%" r="30" fill="url(#parkGradient)" opacity="0.5" />
            <ellipse cx="70%" cy="15%" rx="35" ry="25" fill="url(#parkGradient)" opacity="0.6" />

            {/* Main roads with rounded ends */}
            <rect x="0" y="28%" width="100%" height="22" rx="2" fill="url(#roadGradient)" />
            <rect x="0" y="58%" width="100%" height="26" rx="2" fill="url(#roadGradient)" />
            <rect x="23%" y="0" width="18" height="100%" rx="2" fill="url(#roadGradient)" />
            <rect x="62%" y="0" width="22" height="100%" rx="2" fill="url(#roadGradient)" />

            {/* Road center lines */}
            <line x1="0" y1="39%" x2="100%" y2="39%" stroke="#fbbf24" strokeWidth="2" strokeDasharray="12 6" opacity="0.6"/>
            <line x1="0" y1="71%" x2="100%" y2="71%" stroke="#fbbf24" strokeWidth="2" strokeDasharray="12 6" opacity="0.6"/>
            <line x1="32%" y1="0" x2="32%" y2="100%" stroke="#fbbf24" strokeWidth="2" strokeDasharray="12 6" opacity="0.6"/>
            <line x1="73%" y1="0" x2="73%" y2="100%" stroke="#fbbf24" strokeWidth="2" strokeDasharray="12 6" opacity="0.6"/>

            {/* Building blocks */}
            <rect x="8%" y="45%" width="35" height="28" rx="4" fill="#d1d5db" />
            <rect x="8%" y="45%" width="35" height="5" rx="2" fill="#9ca3af" />

            <rect x="45%" y="5%" width="50" height="35" rx="4" fill="#d1d5db" />
            <rect x="45%" y="5%" width="50" height="6" rx="2" fill="#9ca3af" />

            <rect x="78%" y="40%" width="40" height="45" rx="4" fill="#d1d5db" />
            <rect x="78%" y="40%" width="40" height="7" rx="2" fill="#9ca3af" />

            <rect x="38%" y="78%" width="55" height="30" rx="4" fill="#d1d5db" />
            <rect x="38%" y="78%" width="55" height="5" rx="2" fill="#9ca3af" />

            <rect x="5%" y="35%" width="25" height="20" rx="3" fill="#c4c9cf" />
            <rect x="52%" y="45%" width="30" height="22" rx="3" fill="#c4c9cf" />

            {/* Small decorative buildings */}
            <rect x="15%" y="20%" width="18" height="14" rx="2" fill="#cdd1d6" />
            <rect x="85%" y="18%" width="22" height="16" rx="2" fill="#cdd1d6" />
            <rect x="42%" y="88%" width="20" height="12" rx="2" fill="#cdd1d6" />
          </svg>

          {/* Premium Heatmap with smooth gradients and animations */}
          {getFilteredVenues().map(v => {
            const intensity = v.crowd / 100;
            const baseColor = v.crowd > 70 ? '#EF4444' : v.crowd > 50 ? '#F59E0B' : v.crowd > 30 ? '#FBBF24' : '#10B981';
            const innerSize = 50 + (intensity * 70);
            const middleSize = 80 + (intensity * 90);
            const outerSize = 120 + (intensity * 110);
            const pulseDelay = (v.id * 0.4) % 2.5;
            return (
              <div key={`heat-${v.id}`} style={{ position: 'absolute', left: `${v.x}%`, top: `${v.y}%`, transform: 'translate(-50%, -50%)', pointerEvents: 'none', zIndex: 1 }}>
                {/* Outermost soft glow */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${outerSize * 1.3}px`, height: `${outerSize * 1.3}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}10 0%, ${baseColor}05 40%, transparent 70%)`, animation: `heatPulseOuter 4s ease-in-out infinite ${pulseDelay}s`, filter: 'blur(4px)' }} />
                {/* Outer glow layer */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${outerSize}px`, height: `${outerSize}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}18 0%, ${baseColor}08 45%, transparent 70%)`, animation: `heatPulseMiddle 3s ease-in-out infinite ${pulseDelay + 0.3}s` }} />
                {/* Middle pulsing layer */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${middleSize}px`, height: `${middleSize}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}30 0%, ${baseColor}12 50%, transparent 75%)`, animation: `heatPulseInner 2.5s ease-in-out infinite ${pulseDelay + 0.6}s` }} />
                {/* Inner bright core */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${innerSize}px`, height: `${innerSize}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}45 0%, ${baseColor}20 40%, transparent 80%)`, animation: `heatPulseCore 2s ease-in-out infinite ${pulseDelay + 0.2}s` }} />
                {/* Center hotspot */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${innerSize * 0.4}px`, height: `${innerSize * 0.4}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}60 0%, ${baseColor}30 60%, transparent 100%)`, animation: `heatGlow 1.5s ease-in-out infinite ${pulseDelay}s` }} />
              </div>
            );
          })}

          {/* Premium Venue Pins with hover effects and animations */}
          {getFilteredVenues().map(v => {
            const isHovered = hoveredPin === v.id;
            const isClicked = clickedPin === v.id;
            const isActive = activeVenue?.id === v.id;
            const pinColor = getCategoryColor(v.category);

            return (
              <button
                key={v.id}
                onClick={() => {
                  setClickedPin(v.id);
                  setTimeout(() => setClickedPin(null), 300);
                  setActiveVenue(v);
                }}
                onMouseEnter={() => setHoveredPin(v.id)}
                onMouseLeave={() => setHoveredPin(null)}
                style={{
                  position: 'absolute',
                  left: `${v.x}%`,
                  top: `${v.y}%`,
                  transform: `translate(-50%, -100%) ${isHovered ? 'scale(1.15) translateY(-4px)' : ''} ${isClicked ? 'scale(0.9)' : ''} ${isActive ? 'scale(1.2) translateY(-6px)' : ''}`,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  zIndex: isActive ? 20 : isHovered ? 15 : 10,
                  transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.2s ease',
                  filter: isHovered || isActive ? 'drop-shadow(0 8px 16px rgba(0,0,0,0.25))' : 'drop-shadow(0 3px 6px rgba(0,0,0,0.15))'
                }}
              >
                <div style={{ position: 'relative' }}>
                  {/* Pin shadow */}
                  <div style={{
                    position: 'absolute',
                    bottom: '-8px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '20px',
                    height: '6px',
                    background: 'radial-gradient(ellipse, rgba(0,0,0,0.3) 0%, transparent 70%)',
                    opacity: isHovered || isActive ? 0.8 : 0.5,
                    transition: 'opacity 0.2s ease'
                  }} />

                  {/* Main pin SVG with gradient */}
                  <svg width="34" height="44" viewBox="0 0 24 32" style={{ filter: isActive ? 'brightness(1.1)' : 'none', transition: 'filter 0.2s ease' }}>
                    <defs>
                      <linearGradient id={`pinGrad-${v.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor={pinColor} stopOpacity="1"/>
                        <stop offset="100%" stopColor={pinColor} stopOpacity="0.8"/>
                      </linearGradient>
                      <filter id={`pinShadow-${v.id}`} x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="1" stdDeviation="1" floodOpacity="0.3"/>
                      </filter>
                    </defs>
                    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill={`url(#pinGrad-${v.id})`} filter={`url(#pinShadow-${v.id})`}/>
                    <path d="M12 1C6 1 1 6 1 12c0 4 4 10 11 19 7-9 11-15 11-19 0-6-5-11-11-11z" fill="rgba(255,255,255,0.15)" />
                    <circle cx="12" cy="11" r="7" fill="white" />
                    <circle cx="12" cy="11" r="6.5" fill="white" stroke="rgba(0,0,0,0.05)" strokeWidth="0.5"/>
                  </svg>

                  {/* Category icon */}
                  <span style={{
                    position: 'absolute',
                    top: '7px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    transition: 'transform 0.2s ease'
                  }}>
                    {v.category === 'Food' ? Icons.pizza(colors.food, 15) : v.category === 'Nightlife' ? Icons.cocktail(colors.nightlife, 15) : v.category === 'Live Music' ? Icons.music(colors.music, 15) : Icons.sports(colors.sports, 15)}
                  </span>

                  {/* Trending badge with animation */}
                  {v.trending && (
                    <span style={{
                      position: 'absolute',
                      top: '-6px',
                      right: '-10px',
                      animation: 'trendingBounce 2s ease-in-out infinite'
                    }}>
                      <div style={{
                        background: 'linear-gradient(135deg, #FF6B35, #F7931E)',
                        borderRadius: '50%',
                        padding: '3px',
                        boxShadow: '0 2px 6px rgba(247,147,30,0.4)'
                      }}>
                        {Icons.flame('white', 11)}
                      </div>
                    </span>
                  )}

                  {/* Crowd indicator ring */}
                  {(isHovered || isActive) && (
                    <div style={{
                      position: 'absolute',
                      top: '2px',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: '30px',
                      height: '30px',
                      borderRadius: '50%',
                      border: `2px solid ${v.crowd > 70 ? colors.red : v.crowd > 40 ? colors.amber : colors.teal}`,
                      opacity: 0.6,
                      animation: 'pinRingPulse 1.5s ease-out infinite'
                    }} />
                  )}

                  {/* Venue name tooltip on hover */}
                  {isHovered && !isActive && (
                    <div style={{
                      position: 'absolute',
                      top: '-32px',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      backgroundColor: 'rgba(13,40,71,0.95)',
                      color: 'white',
                      padding: '4px 10px',
                      borderRadius: '8px',
                      fontSize: '10px',
                      fontWeight: '600',
                      whiteSpace: 'nowrap',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                      animation: 'tooltipFadeIn 0.2s ease-out'
                    }}>
                      {v.name}
                      <div style={{
                        position: 'absolute',
                        bottom: '-5px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: 0,
                        height: 0,
                        borderLeft: '5px solid transparent',
                        borderRight: '5px solid transparent',
                        borderTop: '5px solid rgba(13,40,71,0.95)'
                      }} />
                    </div>
                  )}
                </div>
              </button>
            );
          })}

          {/* User location with premium styling */}
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 25 }}>
            {/* Outer pulse ring */}
            <div style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: '50px',
              height: '50px',
              borderRadius: '50%',
              border: '2px solid rgba(59,130,246,0.3)',
              animation: 'userLocationPulse 2s ease-out infinite'
            }} />
            {/* Middle ring */}
            <div style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              backgroundColor: 'rgba(59,130,246,0.15)',
              animation: 'userLocationPulse 2s ease-out infinite 0.5s'
            }} />
            {/* Main dot */}
            <div style={{
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
              border: '3px solid white',
              boxShadow: '0 3px 10px rgba(59,130,246,0.4), inset 0 1px 2px rgba(255,255,255,0.3)'
            }} />
          </div>
        </div>

        {/* Connect Panel */}
        {showConnectPanel && (
          <div style={{ position: 'absolute', left: '8px', right: '8px', top: '8px', backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 40, maxHeight: '65%', overflow: 'auto' }}>
            <div style={{ padding: '12px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, backgroundColor: 'white', borderRadius: '12px 12px 0 0' }}>
              <h2 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.navy, 16)} Find Your People</h2>
              <button onClick={() => setShowConnectPanel(false)} style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 14)}</button>
            </div>
            <div style={{ padding: '12px' }}>
              {connections.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '8px', backgroundColor: colors.cream, marginBottom: '8px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>{c.interests[0] === 'Live Music' ? Icons.music(colors.music, 20) : Icons.sports(colors.sports, 20)}</div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 'bold', fontSize: '12px', color: colors.navy, margin: 0 }}>{c.name}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{c.loc} • {c.distance}</p>
                  </div>
                  <button onClick={() => { setConnections(prev => prev.map(conn => conn.id === c.id ? { ...conn, status: 'pending' } : conn)); showToast('Request sent!'); }} disabled={c.status === 'pending'} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: c.status === 'pending' ? '#e5e7eb' : colors.navy, color: c.status === 'pending' ? '#6b7280' : 'white' }}>
                    {c.status === 'pending' ? 'Pending' : 'Connect'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Venue Popup with AI Crowd Forecast */}
        {activeVenue && !showConnectPanel && (
          <div style={{ position: 'absolute', bottom: '12px', left: '8px', right: '8px', backgroundColor: 'white', borderRadius: '16px', boxShadow: '0 8px 32px rgba(0,0,0,0.25)', zIndex: 45, overflow: 'hidden', maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ height: '56px', background: `linear-gradient(135deg, ${getCategoryColor(activeVenue.category)}, ${activeVenue.crowd > 70 ? colors.red : colors.navy})`, position: 'relative', padding: '8px 12px', display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={() => setActiveVenue(null)} style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 14)}</button>
              <div style={{ color: 'white' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '900', margin: 0 }}>{activeVenue.name}</h3>
                <p style={{ fontSize: '10px', opacity: 0.8, margin: 0 }}>{activeVenue.type} • {activeVenue.price}</p>
              </div>
              <div style={{ position: 'absolute', bottom: '8px', right: '40px', display: 'flex', alignItems: 'center', gap: '2px', backgroundColor: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: '10px' }}>
                {Icons.party('#fbbf24', 10)}
                <span style={{ color: 'white', fontSize: '10px', fontWeight: 'bold', marginLeft: '2px' }}>{activeVenue.stars}</span>
              </div>
            </div>
            <div style={{ padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: '#6b7280', marginBottom: '8px' }}>
                {Icons.mapPin('#6b7280', 12)}
                <span>{activeVenue.addr}</span>
              </div>

              {/* AI Crowd Forecast Widget */}
              <div style={{ backgroundColor: '#f9fafb', borderRadius: '12px', padding: '10px', marginBottom: '10px', border: '1px solid rgba(13,40,71,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Icons.robot(colors.navy, 14)}
                    <span style={{ fontSize: '11px', fontWeight: 'bold', color: colors.navy }}>AI Crowd Forecast</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: '#22C55E', animation: 'pulse 2s ease-in-out infinite' }} />
                    <span style={{ fontSize: '9px', color: '#22C55E', fontWeight: '500' }}>LIVE</span>
                    <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '10px', backgroundColor: '#dbeafe', color: '#1d4ed8', fontWeight: '600' }}>87% accuracy</span>
                  </div>
                </div>

                {/* Crowd Meter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ width: '50px', height: '50px', borderRadius: '25px', background: `conic-gradient(${activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal} ${activeVenue.crowd * 3.6}deg, #e5e7eb 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                      <span style={{ fontSize: '14px', fontWeight: '900', color: activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal }}>{activeVenue.crowd}%</span>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>{activeVenue.crowd > 70 ? 'Very Busy' : activeVenue.crowd > 40 ? 'Moderate' : 'Not Busy'}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>Capacity: ~{Math.round(activeVenue.crowd * 1.5)} / 150 people</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {Icons.clock(colors.teal, 10)}
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: colors.teal }}>Best time: {activeVenue.best}</span>
                    </div>
                  </div>
                </div>

                {/* Hourly Forecast Graph */}
                <div style={{ marginBottom: '10px' }}>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Hourly Forecast</p>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '40px' }}>
                    {[30, 35, 45, 55, 70, 85, 90, 80, 65, 50, 35, 25].map((h, i) => (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                        <div style={{ width: '100%', height: `${h * 0.4}px`, borderRadius: '2px', backgroundColor: h > 70 ? colors.red : h > 40 ? colors.amber : colors.teal, opacity: i === 5 ? 1 : 0.6 }} />
                        <span style={{ fontSize: '7px', color: '#9ca3af' }}>{6 + i}p</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Peak Time Prediction */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.trendingUp(colors.red, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Peak</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>10-11 PM</span>
                  </div>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.zap(colors.amber, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Wait</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{activeVenue.crowd > 70 ? '15-20 min' : activeVenue.crowd > 40 ? '5-10 min' : 'No wait'}</span>
                  </div>
                </div>

                {/* Similar Venues */}
                <div>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Quieter Options</p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {allVenues.filter(v => v.id !== activeVenue.id && v.category === activeVenue.category).slice(0, 2).map(v => (
                      <button key={v.id} onClick={() => setActiveVenue(v)} style={{ flex: 1, padding: '6px', backgroundColor: 'white', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '8px', cursor: 'pointer', textAlign: 'left' }}>
                        <p style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, margin: 0 }}>{v.name}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: v.crowd > 70 ? colors.red : v.crowd > 40 ? colors.amber : colors.teal }} />
                          <span style={{ fontSize: '9px', color: '#6b7280' }}>{v.crowd}% full</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '6px' }}>
                {pickingVenueForCreate ? (
                  <button onClick={() => { setSelectedVenueForCreate(activeVenue); setActiveVenue(null); setPickingVenueForCreate(false); setCurrentScreen('create'); showToast('Selected!'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: colors.teal, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.check('white', 14)} Select</button>
                ) : (
                  <button onClick={() => { setSelectedVenueForCreate(activeVenue); setActiveVenue(null); setCurrentScreen('create'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.users('white', 14)} Start Flock Here</button>
                )}
                <button onClick={() => addEventToCalendar(`Visit ${activeVenue.name}`, activeVenue.name, new Date(), '8 PM', getCategoryColor(activeVenue.category))} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.calendar(colors.navy, 18)}</button>
                <button onClick={() => showToast('Calling venue...')} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.wave(colors.navy, 18)}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Categories */}
      <div style={{ padding: '8px', backgroundColor: 'white', boxShadow: '0 -2px 4px rgba(0,0,0,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
          {[
              { id: 'All', icon: () => Icons.sparkles(category === 'All' ? colors.cream : colors.navy, 14) },
              { id: 'Food', icon: () => Icons.pizza(category === 'Food' ? colors.cream : colors.food, 14) },
              { id: 'Nightlife', icon: () => Icons.cocktail(category === 'Nightlife' ? colors.cream : colors.nightlife, 14) },
              { id: 'Live Music', icon: () => Icons.music(category === 'Live Music' ? colors.cream : colors.music, 14) },
              { id: 'Sports', icon: () => Icons.sports(category === 'Sports' ? colors.cream : colors.sports, 14) }
            ].map(c => (
            <button key={c.id} onClick={() => { setCategory(c.id); setActiveVenue(null); }} style={{ padding: '8px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: category === c.id ? colors.navy : 'white', color: category === c.id ? colors.cream : colors.navy, fontWeight: 'bold', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              {c.icon()} {c.id}
            </button>
          ))}
        </div>
      </div>

      <SafetyButton />
      <BottomNav />
    </div>
  );

  // CALENDAR SCREEN (simplified)
  const CalendarScreen = () => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const daysInMonth = getDaysInMonth(calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarMonth);
    const selectedDateStr = formatDateStr(selectedDate);
    const eventsOnSelected = getEventsForDate(selectedDateStr);
    const today = new Date();
    const todayStr = formatDateStr(today);
    const isToday = (dateStr) => dateStr === todayStr;

    // Event categories
    const eventCategories = [
      { id: 'social', label: 'Social', color: colors.navy, icon: Icons.users },
      { id: 'dining', label: 'Dining', color: colors.food, icon: Icons.pizza },
      { id: 'nightlife', label: 'Nightlife', color: colors.nightlife, icon: Icons.cocktail },
      { id: 'music', label: 'Music', color: colors.music, icon: Icons.music },
    ];

    // Upcoming events (next 7 days)
    const getUpcomingEvents = () => {
      const upcoming = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const events = getEventsForDate(formatDateStr(d));
        events.forEach(e => upcoming.push({ ...e, dayLabel: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }) }));
      }
      return upcoming.slice(0, 4);
    };

    // Weather data (mock)
    const getWeatherForDate = (dateStr) => {
      const weathers = [
        { icon: Icons.sun, temp: '72°', condition: 'Sunny' },
        { icon: Icons.cloud, temp: '65°', condition: 'Cloudy' },
        { icon: Icons.sun, temp: '78°', condition: 'Clear' },
      ];
      return weathers[Math.abs(dateStr.split('-')[2]) % 3];
    };

    const weather = getWeatherForDate(selectedDateStr);

    return (
      <div key="calendar-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 16)}</button>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>{monthNames[calendarMonth.getMonth()]}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{calendarMonth.getFullYear()}</p>
            </div>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowRight('white', 16)}</button>
          </div>
          {/* Today Quick Jump */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setCalendarMonth(today); setSelectedDate(today); }} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              {Icons.zap('#F59E0B', 12)}
              Jump to Today
            </button>
          </div>
        </div>

        {/* Day names header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '8px', backgroundColor: 'white' }}>
          {dayNames.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 'bold', color: '#9ca3af' }}>{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '0 8px 8px', backgroundColor: 'white', flexShrink: 0 }}>
          {[...Array(firstDay)].map((_, i) => <div key={`e-${i}`} style={{ height: '40px' }} />)}
          {[...Array(daysInMonth)].map((_, i) => {
            const day = i + 1;
            const dateStr = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const events = getEventsForDate(dateStr);
            const isSelected = dateStr === selectedDateStr;
            const isTodayDate = isToday(dateStr);
            const isBusy = events.length >= 2;
            return (
              <button key={day} onClick={() => setSelectedDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day))} style={{ height: '40px', borderRadius: '10px', border: isTodayDate && !isSelected ? `2px solid ${colors.teal}` : 'none', backgroundColor: isSelected ? colors.navy : isBusy ? 'rgba(13,40,71,0.05)' : 'transparent', color: isSelected ? 'white' : isTodayDate ? colors.teal : 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ fontSize: '12px', fontWeight: isTodayDate || isSelected ? '700' : '500' }}>{day}</span>
                {events.length > 0 && (
                  <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                    {events.slice(0, 3).map((e, idx) => <div key={idx} style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: isSelected ? 'white' : e.color }} />)}
                  </div>
                )}
                {isBusy && !isSelected && <div style={{ position: 'absolute', top: '2px', right: '4px', width: '6px', height: '6px', borderRadius: '3px', backgroundColor: colors.amber }} />}
              </button>
            );
          })}
        </div>

        {/* Events section */}
        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Weather widget for selected date */}
          <div style={{ ...styles.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', background: 'linear-gradient(135deg, #dbeafe, #e0f2fe)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {weather.icon('#F59E0B', 28)}
              <div>
                <p style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: 0 }}>{weather.temp}</p>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{weather.condition}</p>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}</p>
              <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
            </div>
          </div>

          {/* Selected date events header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.calendar(colors.navy, 14)}
              {isToday(selectedDateStr) ? 'Today' : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </h3>
            <button onClick={() => setShowAddEvent(true)} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {Icons.plus('white', 12)} Add
            </button>
          </div>

          {/* Events list */}
          {eventsOnSelected.length > 0 ? eventsOnSelected.map(event => (
            <div key={event.id} style={{ ...styles.card, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '10px', background: `linear-gradient(135deg, ${event.color}, ${event.color}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {Icons.party('white', 20)}
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>{event.title}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.clock('#6b7280', 10)} {event.time}</span>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', 10)} {event.venue}</span>
                </div>
                {event.members > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginTop: '4px' }}>{Icons.users('#6b7280', 10)}<span style={{ fontSize: '9px', color: '#6b7280' }}>{event.members} going</span></div>}
              </div>
              <button onClick={() => setCalendarEvents(calendarEvents.filter(e => e.id !== event.id))} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: '#fee2e2', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 14)}</button>
            </div>
          )) : (
            <div style={{ textAlign: 'center', padding: '24px' }}>
              {Icons.calendar('#9ca3af', 40)}
              <p style={{ color: '#9ca3af', fontSize: '14px', margin: '8px 0 0' }}>No events scheduled</p>
            </div>
          )}

          {/* Add event form */}
          {showAddEvent && (
            <div style={{ ...styles.card, marginTop: '12px', border: `2px solid ${colors.navy}` }}>
              <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.plus(colors.navy, 14)} New Event</h4>
              <input key="event-title" id="event-title" type="text" value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} placeholder="Event title" style={{ ...styles.input, marginBottom: '8px' }} autoComplete="off" />
              <input key="event-venue" id="event-venue" type="text" value={newEventVenue} onChange={(e) => setNewEventVenue(e.target.value)} placeholder="Venue (optional)" style={{ ...styles.input, marginBottom: '10px' }} autoComplete="off" />
              {/* Event categories */}
              <p style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', marginBottom: '6px' }}>Category</p>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {eventCategories.map(cat => (
                  <button key={cat.id} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${cat.color}`, backgroundColor: 'white', cursor: 'pointer', fontSize: '10px', color: cat.color, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {cat.icon(cat.color, 12)} {cat.label}
                  </button>
                ))}
              </div>
              {/* Repeat toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #eee', marginBottom: '10px' }}>
                <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.repeat(colors.navy, 12)} Repeat weekly</span>
                <Toggle on={false} onChange={() => showToast('Repeat enabled')} />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => { setShowAddEvent(false); setNewEventTitle(''); setNewEventVenue(''); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { if (newEventTitle.trim()) { addEventToCalendar(newEventTitle, newEventVenue || 'TBD', selectedDate, '7:00 PM', colors.navy); setNewEventTitle(''); setNewEventVenue(''); setShowAddEvent(false); }}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.check('white', 14)} Add</button>
              </div>
            </div>
          )}

          {/* Upcoming events preview */}
          {!showAddEvent && getUpcomingEvents().length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.trendingUp(colors.navy, 12)} Coming Up</h4>
              {getUpcomingEvents().map((event, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '10px', backgroundColor: 'white', marginBottom: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ width: '4px', height: '32px', borderRadius: '2px', backgroundColor: event.color }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{event.title}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{event.dayLabel} at {event.time}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // CHAT LIST SCREEN
  const ChatListScreen = () => {
    const totalConversations = flocks.length + directMessages.length;
    const allChats = [
      ...directMessages.map(dm => ({ ...dm, type: 'dm', sortTime: dm.messages[dm.messages.length - 1]?.time })),
      ...flocks.map(f => ({ ...f, type: 'flock', sortTime: f.messages[f.messages.length - 1]?.time }))
    ].filter(c => !chatSearch || (c.type === 'dm' ? c.friendName : c.name).toLowerCase().includes(chatSearch.toLowerCase()));

    return (
      <div key="chat-list-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>Messages</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{totalConversations} conversations</p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setShowNewDmModal(true)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {Icons.plus(colors.navy, 18)}
              </button>
              <button onClick={() => setShowChatSearch(!showChatSearch)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {Icons.search('white', 18)}
              </button>
            </div>
          </div>
          {showChatSearch && (
            <div style={{ marginTop: '12px' }}>
              <input type="text" value={chatSearch} onChange={(e) => setChatSearch(e.target.value)} placeholder="Search conversations..." style={{ width: '100%', padding: '10px 14px', borderRadius: '20px', border: 'none', fontSize: '13px', outline: 'none', backgroundColor: 'rgba(255,255,255,0.95)' }} autoComplete="off" />
            </div>
          )}
        </div>
        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Direct Messages */}
          {allChats.filter(c => c.type === 'dm').map((dm) => {
            const lastMsg = dm.messages[dm.messages.length - 1];
            return (
              <button key={dm.id} onClick={() => { setSelectedDmId(dm.id); setCurrentScreen('dmDetail'); setDirectMessages(prev => prev.map(d => d.id === dm.id ? { ...d, unread: 0 } : d)); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' }}>
                <div style={{ position: 'relative' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '24px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px' }}>
                    {dm.avatar}
                  </div>
                  {dm.isOnline && <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: dm.unread ? '800' : '600', color: colors.navy, margin: 0 }}>{dm.friendName}</h3>
                    <span style={{ fontSize: '10px', color: dm.isOnline ? '#22C55E' : '#9ca3af', fontWeight: dm.unread ? '600' : '400' }}>{dm.isOnline ? 'Online' : dm.lastActive}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {lastMsg?.sender === 'You' && <span style={{ flexShrink: 0 }}>{Icons.checkDouble('#22C55E', 12)}</span>}
                    <p style={{ fontSize: '12px', color: dm.unread ? colors.navy : '#6b7280', fontWeight: dm.unread ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsg?.sender === 'You' ? 'You: ' : ''}{lastMsg?.text}</p>
                  </div>
                </div>
                {dm.unread > 0 && (
                  <div style={{ width: '22px', height: '22px', borderRadius: '11px', background: 'linear-gradient(135deg, #EF4444, #DC2626)', color: 'white', fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {dm.unread}
                  </div>
                )}
              </button>
            );
          })}

          {/* Group Flocks */}
          {allChats.filter(c => c.type === 'flock').map((f, idx) => {
            const unreadCount = idx === 0 ? 3 : idx === 1 ? 1 : 0;
            const isOnline = idx < 2;
            const lastMsg = f.messages[f.messages.length - 1];
            return (
              <button key={f.id} onClick={() => { setSelectedFlockId(f.id); setCurrentScreen('chatDetail'); simulateTyping(); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' }}>
                <div style={{ position: 'relative' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}>
                    {Icons.users('white', 22)}
                  </div>
                  {isOnline && <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <h3 style={{ fontSize: '14px', fontWeight: unreadCount ? '800' : '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h3>
                      <span style={{ fontSize: '9px', color: '#9ca3af', backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '8px' }}>Group</span>
                    </div>
                    <span style={{ fontSize: '10px', color: unreadCount ? colors.navy : '#9ca3af', fontWeight: unreadCount ? '600' : '400' }}>{getRelativeTime(lastMsg?.time)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {lastMsg?.sender === 'You' && <span style={{ flexShrink: 0 }}>{Icons.checkDouble('#22C55E', 12)}</span>}
                    <p style={{ fontSize: '12px', color: unreadCount ? colors.navy : '#6b7280', fontWeight: unreadCount ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsg?.sender === 'You' ? 'You: ' : `${lastMsg?.sender}: `}{lastMsg?.text}</p>
                  </div>
                </div>
                {unreadCount > 0 && (
                  <div style={{ width: '22px', height: '22px', borderRadius: '11px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {unreadCount}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // CHAT DETAIL SCREEN - Enhanced with location cards, timestamps, typing indicators, and image sharing
  const ChatDetailScreen = () => {
    const flock = getSelectedFlock();
    const reactions = ['❤️', '👍', '😂', '🔥'];

    // Venue Card Component for chat
    const VenueCard = ({ venue, onViewDetails, onVote }) => {
      const crowdColor = venue.crowd > 70 ? colors.red : venue.crowd > 40 ? colors.amber : colors.teal;
      return (
        <div style={{
          backgroundColor: 'white',
          borderRadius: '16px',
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
          border: '1px solid rgba(0,0,0,0.06)',
          width: '100%',
          maxWidth: '280px',
          animation: 'cardSlideIn 0.4s ease-out'
        }}>
          {/* Header with gradient */}
          <div style={{
            background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`,
            padding: '12px 14px',
            position: 'relative'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h4 style={{ color: 'white', fontSize: '14px', fontWeight: '700', margin: 0 }}>{venue.name}</h4>
                <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: '11px', margin: '2px 0 0' }}>{venue.type}</p>
              </div>
              <div style={{
                backgroundColor: 'rgba(255,255,255,0.2)',
                padding: '4px 8px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}>
                {Icons.starFilled('#fbbf24', 12)}
                <span style={{ color: 'white', fontSize: '12px', fontWeight: '600' }}>{venue.stars}</span>
              </div>
            </div>
          </div>

          {/* Details */}
          <div style={{ padding: '12px 14px' }}>
            {/* Address */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
              {Icons.mapPin('#6b7280', 12)}
              <span style={{ fontSize: '11px', color: '#6b7280' }}>{venue.addr}</span>
            </div>

            {/* Info row */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {Icons.dollar('#6b7280', 12)}
                <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600' }}>{venue.price}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {Icons.clock('#6b7280', 12)}
                <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600' }}>{venue.best}</span>
              </div>
            </div>

            {/* Crowd indicator */}
            <div style={{
              backgroundColor: '#f8fafc',
              borderRadius: '12px',
              padding: '10px 12px',
              marginBottom: '12px',
              border: '1px solid #e2e8f0'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '500' }}>Current Crowd</span>
                <div style={{
                  backgroundColor: `${crowdColor}20`,
                  color: crowdColor,
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '11px',
                  fontWeight: '700'
                }}>
                  {venue.crowd}%
                </div>
              </div>
              <div style={{ width: '100%', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${venue.crowd}%`,
                  backgroundColor: crowdColor,
                  borderRadius: '3px',
                  transition: 'width 0.5s ease-out'
                }} />
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={onViewDetails}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: `2px solid ${colors.navy}`,
                  backgroundColor: 'white',
                  color: colors.navy,
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                  transition: 'all 0.2s ease'
                }}
              >
                {Icons.eye(colors.navy, 14)} View Details
              </button>
              <button
                onClick={onVote}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: 'none',
                  background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
                  color: 'white',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                  boxShadow: '0 2px 8px rgba(13,40,71,0.25)',
                  transition: 'all 0.2s ease'
                }}
              >
                {Icons.vote('white', 14)} Vote for This
              </button>
            </div>
          </div>
        </div>
      );
    };

    return (
      <div key="chat-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
          <button onClick={() => { setCurrentScreen('main'); setChatInput(''); setReplyingTo(null); }} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.2s ease' }}>{Icons.arrowLeft('white', 20)}</button>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontWeight: 'bold', color: 'white', fontSize: '14px', margin: 0 }}>{flock.name}</h2>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flock.members.length} members • {isTyping ? <span style={{ color: '#86EFAC', fontWeight: '500' }}>{typingUser} is typing...</span> : 'online'}</p>
          </div>
          <button onClick={() => setShowVenueShareModal(true)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease' }}>{Icons.mapPin('white', 16)}</button>
          <button onClick={() => setShowChatSearch(!showChatSearch)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease' }}>{Icons.search('white', 16)}</button>
          <button onClick={() => setShowChatPool(true)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease' }}>{Icons.dollar(colors.navy, 16)}</button>
        </div>

        <div onScroll={() => document.activeElement?.blur()} style={{ flex: 1, padding: '16px', overflowY: 'auto', background: `linear-gradient(180deg, ${colors.cream} 0%, rgba(245,240,230,0.8) 100%)`, scrollBehavior: 'smooth' }}>
          {flock.messages.map((m, idx) => (
            <div
              key={m.id}
              onTouchStart={(e) => handleTouchStart(m.id, e)}
              onTouchMove={(e) => handleTouchMove(m.id, e)}
              onTouchEnd={(e) => handleTouchEnd(m.id, m, e)}
              style={{
                display: 'flex',
                gap: '10px',
                marginBottom: '16px',
                flexDirection: m.sender === 'You' ? 'row-reverse' : 'row',
                position: 'relative',
                transform: swipeState.id === m.id ? `translateX(${swipeState.x}px)` : 'translateX(0)',
                transition: swipeState.id === m.id ? 'none' : 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                animation: 'fadeIn 0.3s ease-out'
              }}
            >
              {/* Swipe hint icon */}
              {swipeState.id === m.id && swipeState.x > 20 && (
                <div style={{ position: 'absolute', left: '-30px', top: '50%', transform: 'translateY(-50%)', opacity: Math.min(swipeState.x / 50, 1), transition: 'opacity 0.2s ease' }}>
                  {Icons.reply(colors.navy, 20)}
                </div>
              )}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '17px', background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'white', border: m.sender === 'You' ? 'none' : '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: m.sender === 'You' ? 'white' : colors.navy, boxShadow: m.sender === 'You' ? '0 3px 10px rgba(13,40,71,0.25)' : '0 2px 6px rgba(0,0,0,0.06)', transition: 'transform 0.2s ease' }}>
                  {m.sender[0]}
                </div>
                {m.sender !== 'You' && idx === 0 && <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '10px', height: '10px', borderRadius: '5px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
              </div>
              <div style={{ maxWidth: '72%', display: 'flex', flexDirection: 'column', alignItems: m.sender === 'You' ? 'flex-end' : 'flex-start' }}>
                {/* Sender name and timestamp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', padding: '0 4px' }}>
                  <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600' }}>{m.sender}</span>
                  <span style={{ fontSize: '10px', color: '#9ca3af' }}>•</span>
                  <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: '500' }}>{m.time || getRelativeTime(m.time)}</span>
                </div>

                {/* Image message */}
                {m.image && (
                  <div style={{
                    borderRadius: '16px',
                    overflow: 'hidden',
                    boxShadow: '0 4px 15px rgba(0,0,0,0.1)',
                    marginBottom: '4px'
                  }}>
                    <img src={m.image} alt="Shared" style={{ width: '200px', height: '150px', objectFit: 'cover', display: 'block' }} />
                  </div>
                )}

                {/* Venue Card message */}
                {m.venueCard && (
                  <VenueCard
                    venue={m.venueCard}
                    onViewDetails={() => {
                      const venue = allVenues.find(v => v.id === m.venueCard.id);
                      if (venue) {
                        setActiveVenue(venue);
                        setCurrentTab('explore');
                        setCurrentScreen('main');
                      }
                    }}
                    onVote={() => {
                      const existingVote = flock.votes.find(v => v.venue === m.venueCard.name);
                      if (existingVote) {
                        const newVotes = flock.votes.map(v => ({
                          ...v,
                          voters: v.venue === m.venueCard.name
                            ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You'])
                            : v.voters.filter(x => x !== 'You')
                        }));
                        updateFlockVotes(selectedFlockId, newVotes);
                      } else {
                        const newVotes = [...flock.votes, { venue: m.venueCard.name, type: m.venueCard.type, voters: ['You'] }];
                        updateFlockVotes(selectedFlockId, newVotes);
                      }
                      showToast(`Voted for ${m.venueCard.name}!`);
                      addXP(10);
                    }}
                  />
                )}

                {/* Regular text message */}
                {m.text && (
                  <div
                    onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                    style={{
                      borderRadius: '18px',
                      padding: '10px 14px',
                      background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyMid} 100%)` : 'rgba(255,255,255,0.95)',
                      backdropFilter: 'blur(10px)',
                      WebkitBackdropFilter: 'blur(10px)',
                      color: m.sender === 'You' ? 'white' : colors.navy,
                      borderBottomRightRadius: m.sender === 'You' ? '4px' : '18px',
                      borderBottomLeftRadius: m.sender === 'You' ? '18px' : '4px',
                      boxShadow: m.sender === 'You' ? '0 3px 12px rgba(13,40,71,0.2)' : '0 2px 10px rgba(0,0,0,0.05)',
                      border: m.sender === 'You' ? 'none' : '1px solid rgba(255,255,255,0.8)',
                      cursor: 'pointer',
                      position: 'relative',
                      transition: 'transform 0.15s ease, box-shadow 0.15s ease'
                    }}
                  >
                    <p style={{ fontSize: '14px', lineHeight: '1.45', margin: 0, fontWeight: '500' }}>{m.text}</p>
                    {m.sender === 'You' && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px', gap: '2px', alignItems: 'center' }}>
                        {Icons.checkDouble('#86EFAC', 12)}
                      </div>
                    )}
                  </div>
                )}

                {/* Reaction picker */}
                {showReactionPicker === m.id && (
                  <div style={{
                    display: 'flex',
                    gap: '4px',
                    marginTop: '6px',
                    padding: '6px 10px',
                    backgroundColor: 'white',
                    borderRadius: '24px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                    animation: 'reactionPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
                  }}>
                    {reactions.map(r => (
                      <button
                        key={r}
                        onClick={(e) => { e.stopPropagation(); addReactionToMessage(flock.id, m.id, r); }}
                        style={{
                          background: 'none',
                          border: 'none',
                          fontSize: '20px',
                          cursor: 'pointer',
                          padding: '6px',
                          borderRadius: '10px',
                          transition: 'transform 0.15s ease, background-color 0.15s ease'
                        }}
                      >{r}</button>
                    ))}
                    <button onClick={(e) => { e.stopPropagation(); setReplyingTo(m); setShowReactionPicker(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '10px' }}>{Icons.reply('#6b7280', 18)}</button>
                  </div>
                )}

                {/* Reactions display */}
                {m.reactions && m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
                    {m.reactions.map((r, i) => (
                      <span
                        key={i}
                        className="reaction-pop"
                        style={{
                          fontSize: '14px',
                          backgroundColor: 'white',
                          borderRadius: '14px',
                          padding: '4px 8px',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                          border: '1px solid rgba(0,0,0,0.05)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        {r}
                        <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: '500' }}>1</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Enhanced typing indicator with user name */}
          {isTyping && (
            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', animation: 'fadeIn 0.3s ease-out' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'white', border: '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: colors.navy }}>{typingUser?.[0] || 'A'}</div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '11px', color: colors.navy, fontWeight: '600', marginBottom: '4px', paddingLeft: '4px' }}>{typingUser || 'Alex'}</span>
                <div style={{ padding: '12px 16px', backgroundColor: 'white', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.2s infinite', opacity: 0.7 }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: colors.navy, animation: 'typingDot 1.4s ease-in-out 0.4s infinite', opacity: 0.7 }} />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Reply bar */}
        {replyingTo && (
          <div style={{ padding: '10px 16px', backgroundColor: 'rgba(13,40,71,0.05)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '10px', animation: 'slideUp 0.2s ease-out' }}>
            <div style={{ width: '3px', height: '36px', backgroundColor: colors.navy, borderRadius: '2px' }} />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>Replying to {replyingTo.sender}</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyingTo.text}</p>
            </div>
            <button onClick={() => setReplyingTo(null)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(0,0,0,0.05)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.2s ease' }}>{Icons.x('#6b7280', 16)}</button>
          </div>
        )}

        {/* Image preview bar */}
        {showImagePreview && pendingImage && (
          <div style={{ padding: '12px 16px', backgroundColor: 'rgba(13,40,71,0.05)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '12px', animation: 'slideUp 0.2s ease-out' }}>
            <div style={{ position: 'relative' }}>
              <img src={pendingImage} alt="Preview" style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }} />
              <button
                onClick={() => { setPendingImage(null); setShowImagePreview(false); }}
                style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', borderRadius: '11px', backgroundColor: colors.red, border: '2px solid white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {Icons.x('white', 12)}
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>Ready to send</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>Tap send to share this image</p>
            </div>
            <button
              onClick={() => shareImageToChat(selectedFlockId)}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '22px',
                border: 'none',
                background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
                color: 'white',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 3px 10px rgba(13,40,71,0.25)'
              }}
            >
              {Icons.send('white', 18)}
            </button>
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: '10px 12px', backgroundColor: 'rgba(255,255,255,0.98)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, boxShadow: '0 -4px 20px rgba(0,0,0,0.03)' }}>
          <button onClick={handleChatImageSelect} style={{ width: '38px', height: '38px', borderRadius: '19px', border: 'none', backgroundColor: 'rgba(13,40,71,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s ease' }}>{Icons.camera('#6b7280', 18)}</button>
          <input key="chat-input" id="chat-input" type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()} placeholder={replyingTo ? 'Reply...' : 'Type a message...'} style={{ flex: 1, padding: '12px 16px', borderRadius: '22px', backgroundColor: 'rgba(243,244,246,0.9)', border: '1px solid rgba(0,0,0,0.05)', fontSize: '14px', outline: 'none', fontWeight: '500', transition: 'all 0.2s ease' }} autoComplete="off" />
          {chatInput ? (
            <button onClick={sendChatMessage} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.send('white', 18)}</button>
          ) : (
            <button onClick={() => showToast('Recording voice...')} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)', transition: 'all 0.2s ease' }}>{Icons.mic('white', 18)}</button>
          )}
        </div>

        {/* Cash Pool Modal */}
        {showChatPool && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Cash Pool</h2>
                <button onClick={() => setShowChatPool(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '16px' }}>
                <button onClick={() => setChatPoolAmount(prev => Math.max(5, prev - 5))} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px', transition: 'all 0.2s ease' }}>−</button>
                <span style={{ fontSize: '36px', fontWeight: '900', width: '100px', textAlign: 'center', color: colors.navy }}>${chatPoolAmount}</span>
                <button onClick={() => setChatPoolAmount(prev => prev + 5)} style={{ width: '44px', height: '44px', borderRadius: '22px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer', fontSize: '18px', transition: 'all 0.2s ease' }}>+</button>
              </div>
              <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', marginBottom: '20px' }}>Per person • Total: ${chatPoolAmount * flock.members.length}</p>
              <button onClick={() => { addMessageToFlock(selectedFlockId, { id: Date.now(), sender: 'You', time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), text: `💰 Pool: $${chatPoolAmount}/person`, reactions: [] }); setShowChatPool(false); showToast('💰 Pool created!'); }} style={{ ...styles.gradientButton, padding: '14px' }}>Create Pool</button>
            </div>
          </div>
        )}

        {/* Venue Share Modal */}
        {showVenueShareModal && (
          <div className="modal-backdrop" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div className="modal-content" style={{ backgroundColor: 'white', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxHeight: '70%', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>{Icons.mapPin(colors.navy, 20)} Share a Venue</h2>
                <button onClick={() => setShowVenueShareModal(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 18)}</button>
              </div>
              <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>Select a venue to share with your flock</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {allVenues.map(venue => (
                  <button
                    key={venue.id}
                    onClick={() => shareVenueToChat(selectedFlockId, venue)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px',
                      borderRadius: '14px',
                      border: '1px solid #e2e8f0',
                      backgroundColor: 'white',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <div style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: `linear-gradient(135deg, ${getCategoryColor(venue.category)}, ${getCategoryColor(venue.category)}cc)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {venue.category === 'Food' ? Icons.pizza('white', 20) : venue.category === 'Nightlife' ? Icons.cocktail('white', 20) : venue.category === 'Live Music' ? Icons.music('white', 20) : Icons.sports('white', 20)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: '14px', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                      <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0 0' }}>{venue.type} • {venue.price}</p>
                    </div>
                    <div style={{
                      padding: '4px 10px',
                      borderRadius: '12px',
                      backgroundColor: venue.crowd > 70 ? '#FEE2E2' : venue.crowd > 40 ? '#FEF3C7' : '#D1FAE5',
                      color: venue.crowd > 70 ? colors.red : venue.crowd > 40 ? colors.amber : colors.teal,
                      fontSize: '11px',
                      fontWeight: '600'
                    }}>
                      {venue.crowd}%
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // FLOCK DETAIL SCREEN
  const FlockDetailScreen = () => {
    const flock = getSelectedFlock();
    const myVote = flock.votes.find(v => v.voters.includes('You'))?.venue || null;

    const handleVote = (venueName) => {
      const newVotes = flock.votes.map(v => ({ ...v, voters: v.venue === venueName ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You']) : v.voters.filter(x => x !== 'You') }));
      updateFlockVotes(selectedFlockId, newVotes);
      addXP(10);
      showToast(`Voted for ${venueName}!`);
    };

    return (
      <div key="flock-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer' }}>←</button>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontWeight: '900', color: 'white', fontSize: '14px', margin: 0 }}>{flock.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flock.host} • {flock.time}</p>
            </div>
            <button onClick={() => addEventToCalendar(flock.name, flock.venue, new Date(), '9 PM')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.calendar('white', 16)}</button>
          </div>
          <div style={{ display: 'flex' }}>
            {flock.members.slice(0, 5).map((m, i) => (
              <div key={i} style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.3)', border: '2px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: 'white', marginLeft: i > 0 ? '-6px' : 0 }}>{m[0]}</div>
            ))}
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', marginLeft: '8px', alignSelf: 'center' }}>{flock.members.length} going</span>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {flock.cashPool && (
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>Cash Pool</h3>
                <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', fontWeight: '500', backgroundColor: flock.cashPool.collected >= flock.cashPool.target ? '#d1fae5' : '#fef3c7', color: flock.cashPool.collected >= flock.cashPool.target ? '#047857' : '#b45309' }}>
                  ${flock.cashPool.collected}/${flock.cashPool.target}
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', marginBottom: '8px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(flock.cashPool.collected / flock.cashPool.target) * 100}%`, background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '4px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: flock.cashPool.collected >= flock.cashPool.target ? '0 0 12px rgba(13,40,71,0.4)' : 'none' }} />
              </div>
              {!flock.cashPool.paid.includes('You') ? (
                <button onClick={() => makePoolPayment(selectedFlockId)} style={{ ...styles.gradientButton, padding: '8px' }}>Pay ${flock.cashPool.perPerson}</button>
              ) : (
                <div style={{ textAlign: 'center', padding: '4px', color: colors.teal, fontWeight: '600', fontSize: '12px' }}>✓ Paid!</div>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>Vote</h2>
          {flock.votes.map(v => (
            <button key={v.venue} onClick={() => handleVote(v.venue)} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>{v.venue}</h3>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{v.type}</p>
                <p style={{ fontSize: '9px', color: colors.navyMid, margin: '2px 0 0' }}>{v.voters.join(', ')}</p>
              </div>
              <span style={{ padding: '6px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', backgroundColor: myVote === v.venue ? colors.navy : colors.cream, color: myVote === v.venue ? 'white' : colors.navy }}>
                {myVote === v.venue ? '✓ ' : ''}{v.voters.length}
              </span>
            </button>
          ))}

          <button onClick={() => setCurrentScreen('chatDetail')} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', marginTop: '12px' }}>
            <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 4px' }}>Chat</h2>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>{flock.messages[flock.messages.length - 1]?.sender}: {flock.messages[flock.messages.length - 1]?.text}</p>
          </button>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={() => showToast('Location shared!')} style={{ ...styles.gradientButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.mapPin('white', 16)} Share Location</button>
        </div>
      </div>
    );
  };

  // PROFILE SCREEN (simplified)
  const ProfileScreen = () => {
    if (profileScreen !== 'main') {
      return (
        <div key={`profile-${profileScreen}-container`} style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
          <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: 'white', flexShrink: 0 }}>
            <button onClick={() => setProfileScreen('main')} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
            <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>{profileScreen === 'edit' ? 'Edit Profile' : profileScreen === 'safety' ? 'Safety' : profileScreen === 'interests' ? 'Interests' : 'Payment'}</h1>
          </div>
          <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
            {profileScreen === 'edit' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user(colors.navy, 32)}
                  </button>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Name</label>
                  <input key="profile-name" id="profile-name" type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} style={styles.input} autoComplete="off" />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Username</label>
                  <input key="profile-handle" id="profile-handle" type="text" value={profileHandle} onChange={(e) => setProfileHandle(e.target.value)} style={styles.input} autoComplete="off" />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Bio</label>
                  <textarea key="profile-bio" id="profile-bio" value={profileBio} onChange={(e) => setProfileBio(e.target.value)} rows={2} style={{ ...styles.input, resize: 'none' }} />
                </div>
              </div>
            )}
            {profileScreen === 'safety' && (
              <div>
                <div style={styles.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>Safety Features</p>
                      <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>Quick exit & check-ins</p>
                    </div>
                    <Toggle on={safetyOn} onChange={() => setSafetyOn(!safetyOn)} />
                  </div>
                </div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 8px' }}>Trusted Contacts</h3>
                  {trustedContacts.map(c => (
                    <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontWeight: '500', fontSize: '14px', color: colors.navy }}>{c}</span>
                      <button onClick={() => { setTrustedContacts(trustedContacts.filter(x => x !== c)); showToast('Removed'); }} style={{ background: 'none', border: 'none', color: colors.red, fontSize: '12px', fontWeight: '500', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                    <input key="new-contact" id="new-contact" type="text" value={newContactName} onChange={(e) => setNewContactName(e.target.value)} placeholder="Add emergency contact..." style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    <button onClick={() => { if (newContactName.trim()) { setTrustedContacts([...trustedContacts, newContactName.trim()]); showToast('✅ Added!'); setNewContactName(''); }}} style={{ padding: '0 16px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}>Add</button>
                  </div>
                </div>
              </div>
            )}
            {profileScreen === 'interests' && (
              <div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Your Interests</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                    {userInterests.map(interest => (
                      <div key={interest} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '20px', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '12px', fontWeight: '600' }}>
                        {interest}
                        <button onClick={() => { setUserInterests(userInterests.filter(i => i !== interest)); showToast('Removed'); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: 0, display: 'flex' }}>{Icons.x('rgba(255,255,255,0.7)', 14)}</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="text" value={newInterest} onChange={(e) => setNewInterest(e.target.value)} placeholder="Add an interest..." style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    <button onClick={() => { if (newInterest.trim() && !userInterests.includes(newInterest.trim())) { setUserInterests([...userInterests, newInterest.trim()]); setNewInterest(''); showToast('✅ Added!'); }}} style={{ padding: '0 16px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}>Add</button>
                  </div>
                </div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Suggested Interests</h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {suggestedInterests.filter(s => !userInterests.includes(s)).map(interest => (
                      <button key={interest} onClick={() => { setUserInterests([...userInterests, interest]); showToast('✅ Added!'); }} style={{ padding: '6px 12px', borderRadius: '20px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '12px', fontWeight: '500', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.plus(colors.navy, 12)} {interest}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {profileScreen === 'payment' && (
              <div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 12px' }}>Saved Cards</h3>
                  {paymentMethods.length === 0 ? (
                    <p style={{ fontSize: '13px', color: '#6b7280', textAlign: 'center', padding: '16px 0' }}>No payment methods saved</p>
                  ) : (
                    paymentMethods.map(card => (
                      <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', backgroundColor: colors.cream, marginBottom: '8px' }}>
                        <div style={{ width: '44px', height: '28px', borderRadius: '4px', background: card.brand === 'Visa' ? 'linear-gradient(135deg, #1A1F71, #2E3691)' : 'linear-gradient(135deg, #EB001B, #F79E1B)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '10px', fontWeight: 'bold' }}>
                          {card.brand}
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: '14px', fontWeight: '600', color: colors.navy, margin: 0 }}>•••• {card.last4}</p>
                          <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Expires {card.expiry}</p>
                        </div>
                        {card.isDefault && <span style={{ fontSize: '9px', fontWeight: '600', color: '#22C55E', backgroundColor: '#DCFCE7', padding: '2px 6px', borderRadius: '4px' }}>Default</span>}
                        <button onClick={() => { setPaymentMethods(paymentMethods.filter(c => c.id !== card.id)); showToast('Card removed'); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#9ca3af', 16)}</button>
                      </div>
                    ))
                  )}
                  {!showAddCard ? (
                    <button onClick={() => setShowAddCard(true)} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.creamDark}`, backgroundColor: 'transparent', color: colors.navy, fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                      {Icons.plus(colors.navy, 16)} Add New Card
                    </button>
                  ) : (
                    <div style={{ marginTop: '12px', padding: '16px', borderRadius: '12px', backgroundColor: colors.cream }}>
                      <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: '0 0 12px' }}>Add New Card</h4>
                      <div style={{ marginBottom: '10px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Card Number</label>
                        <input type="text" value={newCard.number} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 16); const formatted = v.replace(/(\d{4})/g, '$1 ').trim(); setNewCard({ ...newCard, number: formatted }); }} placeholder="1234 5678 9012 3456" style={{ ...styles.input, letterSpacing: '1px' }} autoComplete="off" />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Expiry</label>
                          <input type="text" value={newCard.expiry} onChange={(e) => { let v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2); setNewCard({ ...newCard, expiry: v }); }} placeholder="MM/YY" style={styles.input} autoComplete="off" />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>CVV</label>
                          <input type="text" value={newCard.cvv} onChange={(e) => setNewCard({ ...newCard, cvv: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="123" style={styles.input} autoComplete="off" />
                        </div>
                      </div>
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#6b7280', marginBottom: '4px' }}>Cardholder Name</label>
                        <input type="text" value={newCard.name} onChange={(e) => setNewCard({ ...newCard, name: e.target.value })} placeholder="John Doe" style={styles.input} autoComplete="off" />
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => { setShowAddCard(false); setNewCard({ number: '', expiry: '', cvv: '', name: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                        <button onClick={() => { if (newCard.number.length >= 19 && newCard.expiry.length === 5 && newCard.cvv.length === 3 && newCard.name.trim()) { const brand = newCard.number.startsWith('4') ? 'Visa' : 'MC'; setPaymentMethods([...paymentMethods, { id: Date.now(), brand, last4: newCard.number.slice(-4), expiry: newCard.expiry, isDefault: paymentMethods.length === 0 }]); setNewCard({ number: '', expiry: '', cvv: '', name: '' }); setShowAddCard(false); showToast('✅ Card added!'); } else { showToast('Please fill all fields', 'error'); }}} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Add Card</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
            <button onClick={() => { showToast('✅ Saved!'); setProfileScreen('main'); }} style={styles.gradientButton}>Save</button>
          </div>
        </div>
      );
    }

    return (
      <div key="profile-main-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '20px', textAlign: 'center', background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`, flexShrink: 0 }}>
          <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', margin: '0 auto 8px', backgroundColor: 'rgba(255,255,255,0.2)', border: '4px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: 'pointer' }}>
            {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user(colors.navy, 32)}
          </button>
          <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>{profileName}</h1>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>@{profileHandle}</p>
          <div style={{ marginTop: '12px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '12px', padding: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '10px' }}>Level {userLevel}</span>
              <span style={{ color: 'white', fontWeight: 'bold', fontSize: '12px' }}>{userXP} XP</span>
            </div>
            <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '3px', transition: 'width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)', boxShadow: '0 0 10px rgba(245,158,11,0.5)' }} />
            </div>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
            {[{ l: 'Flocks', v: flocks.length }, { l: 'Friends', v: 48 }, { l: 'Streak', v: streak, hasIcon: true }, { l: 'Events', v: calendarEvents.length }].map(s => (
              <div key={s.l} style={{ backgroundColor: 'white', borderRadius: '12px', padding: '8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <p style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{s.v}{s.hasIcon && Icons.flame('#F59E0B', 16)}</p>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>{s.l}</p>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            {[
              { l: 'Edit Profile', s: 'edit', icon: Icons.edit },
              { l: 'Interests', s: 'interests', icon: Icons.target },
              { l: 'Safety', s: 'safety', icon: Icons.shield },
              { l: 'Payment', s: 'payment', icon: Icons.creditCard },
            ].map(m => (
              <button key={m.s} onClick={() => setProfileScreen(m.s)} style={{ width: '100%', padding: '12px', textAlign: 'left', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{m.icon(colors.navy, 18)}</div>
                <span style={{ flex: 1, fontWeight: '600', fontSize: '14px', color: colors.navy }}>{m.l}</span>
                <span style={{ color: '#9ca3af' }}>›</span>
              </button>
            ))}
            <button onClick={() => showToast('Logged out!')} style={{ width: '100%', padding: '12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer', color: colors.red }}>
              {Icons.logout(colors.red, 18)}
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Log Out</span>
            </button>
          </div>

          {/* Admin Access Button - Small and subtle at bottom */}
          <button
            onClick={() => setShowAdminPrompt(true)}
            style={{
              marginTop: '16px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.settings('#9ca3af', 12)} Admin
          </button>

          {/* Venue Owner Access Button */}
          <button
            onClick={() => setCurrentScreen('venueDashboard')}
            style={{
              marginTop: '8px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.home('#9ca3af', 12)} Venue Dashboard
          </button>

          {/* Switch Mode Button */}
          {userMode && (
            <button
              onClick={switchMode}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #EF4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                color: '#EF4444',
                fontSize: '10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.repeat('#EF4444', 12)} Switch Mode (Current: {userMode === 'user' ? 'User' : userMode === 'venue' ? 'Venue' : 'Admin'})
            </button>
          )}

          {/* Replay Onboarding Button */}
          {userMode === 'user' && (
            <button
              onClick={() => {
                localStorage.removeItem('flockOnboardingComplete');
                setHasCompletedOnboarding(false);
                setOnboardingStep(0);
                setOnboardingName('');
                setOnboardingVibes([]);
              }}
              style={{
                marginTop: '8px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px solid ${colors.teal}`,
                backgroundColor: 'rgba(20,184,166,0.1)',
                color: colors.teal,
                fontSize: '10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                justifyContent: 'center'
              }}
            >
              {Icons.repeat(colors.teal, 12)} Replay Onboarding
            </button>
          )}

          {/* Legal Links */}
          <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${colors.creamDark}` }}>
            <p style={{ fontSize: '10px', color: '#9ca3af', marginBottom: '12px', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Legal</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                onClick={() => window.open('https://flock.app/terms', '_blank')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'white',
                  color: colors.navy,
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.fileText(colors.navy, 14)} Terms of Service
              </button>
              <button
                onClick={() => window.open('https://flock.app/privacy', '_blank')}
                style={{
                  padding: '10px 16px',
                  borderRadius: '10px',
                  border: `1px solid ${colors.creamDark}`,
                  backgroundColor: 'white',
                  color: colors.navy,
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {Icons.shield(colors.navy, 14)} Privacy Policy
              </button>
            </div>
            <p style={{ fontSize: '10px', color: '#9ca3af', marginTop: '16px', textAlign: 'center' }}>Flock v1.0.0</p>
          </div>

        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // VENUE DASHBOARD SCREEN (For Venue Owners)
  const VenueDashboard = () => {
    // venueTab state is now at App level to persist across re-renders
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);

    // Promotion state
    const [promotions, setPromotions] = useState([
      { id: 1, title: 'Happy Hour Special', desc: '50% off drinks', time: '5-7 PM', days: 'Mon-Fri', views: 234, claims: 89 },
      { id: 2, title: 'Late Night Bites', desc: '$5 appetizers', time: '10PM-Close', days: 'Daily', views: 156, claims: 45 }
    ]);
    const [showPromoModal, setShowPromoModal] = useState(false);
    const [editingPromo, setEditingPromo] = useState(null);
    const [promoForm, setPromoForm] = useState({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' });

    // Event state
    const [venueEventsList, setVenueEventsList] = useState([
      { id: 1, title: 'Live Jazz Night', date: 'Jan 24', time: '9:00 PM', rsvps: 45, capacity: 60 },
      { id: 2, title: 'Trivia Tuesday', date: 'Jan 21', time: '7:00 PM', rsvps: 28, capacity: 40 }
    ]);
    const [showEventModal, setShowEventModal] = useState(false);
    const [editingEvent, setEditingEvent] = useState(null);
    const [eventForm, setEventForm] = useState({ title: '', date: '', time: '', capacity: '' });

    // Incoming flocks
    const incomingFlocks = [
      { id: 1, name: "Alex's Birthday Party", time: 'Saturday 8 PM', members: 12, status: 'confirmed' },
      { id: 2, name: 'Friday Night Out', time: 'Friday 10 PM', members: 6, status: 'pending' }
    ];

    // Reviews (read-only)
    const reviews = [
      { id: 1, user: 'Sarah M.', rating: 5, text: 'Great atmosphere and amazing cocktails!', date: '2 days ago', replied: true },
      { id: 2, user: 'Mike J.', rating: 4, text: 'Good drinks, bit crowded on weekends.', date: '1 week ago', replied: false },
      { id: 3, user: 'Emma L.', rating: 5, text: 'Perfect spot for our flock meetup! Staff was super friendly.', date: '2 weeks ago', replied: true }
    ];

    // Settings state
    const [venueInfo, setVenueInfo] = useState({ name: 'The Blue Heron Bar', address: '123 Main St, Easton PA', phone: '(610) 555-0123' });
    const [editingVenueInfo, setEditingVenueInfo] = useState(false);
    const [operatingHours, setOperatingHours] = useState([
      { days: 'Mon-Thu', open: '4:00 PM', close: '12:00 AM' },
      { days: 'Fri-Sat', open: '4:00 PM', close: '2:00 AM' },
      { days: 'Sunday', open: '12:00 PM', close: '10:00 PM' }
    ]);
    const [showHoursModal, setShowHoursModal] = useState(false);
    const [notifications, setNotifications] = useState({ bookings: true, reviews: true, weekly: false });

    // Deal posting state (for quick deals on analytics tab)
    const [dealDescription, setDealDescription] = useState('');
    const [dealTimeSlot, setDealTimeSlot] = useState('Happy Hour');

    const venueTabs = [
      { id: 'analytics', label: 'Analytics', icon: Icons.barChart },
      { id: 'promotions', label: 'Promotions', icon: Icons.gift },
      { id: 'events', label: 'Events', icon: Icons.calendar },
      { id: 'reviews', label: 'Reviews', icon: Icons.star },
      { id: 'settings', label: 'Settings', icon: Icons.settings }
    ];

    // Promotion handlers
    const openPromoModal = (promo = null) => {
      if (promo) {
        setEditingPromo(promo);
        setPromoForm({ title: promo.title, desc: promo.desc, time: promo.time, days: promo.days });
      } else {
        setEditingPromo(null);
        setPromoForm({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' });
      }
      setShowPromoModal(true);
    };

    const savePromo = () => {
      if (!promoForm.title.trim()) return;
      if (editingPromo) {
        setPromotions(prev => prev.map(p => p.id === editingPromo.id ? { ...p, ...promoForm } : p));
        showToast('Promotion updated!');
      } else {
        setPromotions(prev => [...prev, { id: Date.now(), ...promoForm, views: 0, claims: 0 }]);
        showToast('Promotion created!');
      }
      setShowPromoModal(false);
    };

    const deletePromo = (id) => {
      setPromotions(prev => prev.filter(p => p.id !== id));
      showToast('Promotion deleted');
    };

    // Event handlers
    const openEventModal = (event = null) => {
      if (event) {
        setEditingEvent(event);
        setEventForm({ title: event.title, date: event.date, time: event.time, capacity: event.capacity.toString() });
      } else {
        setEditingEvent(null);
        setEventForm({ title: '', date: '', time: '', capacity: '' });
      }
      setShowEventModal(true);
    };

    const saveEvent = () => {
      if (!eventForm.title.trim()) return;
      if (editingEvent) {
        setVenueEventsList(prev => prev.map(e => e.id === editingEvent.id ? { ...e, ...eventForm, capacity: parseInt(eventForm.capacity) || 50 } : e));
        showToast('Event updated!');
      } else {
        setVenueEventsList(prev => [...prev, { id: Date.now(), ...eventForm, capacity: parseInt(eventForm.capacity) || 50, rsvps: 0 }]);
        showToast('Event created!');
      }
      setShowEventModal(false);
    };

    const deleteEvent = (id) => {
      setVenueEventsList(prev => prev.filter(e => e.id !== id));
      showToast('Event deleted');
    };

    // Mock venue data
    const venueData = {
      name: "The Blue Heron Bar",
      logo: null,
      tier: venueTier,
      todayCheckins: 47,
      weekTraffic: 312,
      crowdForecast: 78,
      peakHours: [
        { hour: '6pm', value: 30 },
        { hour: '7pm', value: 45 },
        { hour: '8pm', value: 65 },
        { hour: '9pm', value: 85 },
        { hour: '10pm', value: 95 },
        { hour: '11pm', value: 80 },
        { hour: '12am', value: 55 },
      ],
      topInterests: ['Live Music', 'Cocktails', 'Sports'],
      repeatRate: 34,
      demographics: { '21-25': 35, '26-30': 40, '31-35': 15, '36+': 10 },
    };

    const tierBadge = {
      free: { label: 'Free', color: '#6b7280', bg: '#f3f4f6' },
      premium: { label: 'Premium', color: '#b45309', bg: '#fef3c7' },
      pro: { label: 'Pro', color: '#7c3aed', bg: '#ede9fe' },
    };

    const features = {
      free: ['Basic listing', 'Venue info', 'User reviews'],
      premium: ['Enhanced visibility', 'Post deals', 'Event promotion', 'Basic analytics'],
      pro: ['Everything in Premium', 'Detailed insights', 'Push notifications', 'AI recommendations'],
    };

    const isFeatureLocked = (feature) => {
      if (venueTier === 'pro') return false;
      if (venueTier === 'premium' && ['Post deals', 'Event promotion', 'Basic analytics', 'Enhanced visibility'].includes(feature)) return false;
      if (['Basic listing', 'Venue info', 'User reviews'].includes(feature)) return false;
      return true;
    };

    return (
      <div key="venue-dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            <span style={{ ...tierBadge[venueData.tier], padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: '700', backgroundColor: tierBadge[venueData.tier].bg, color: tierBadge[venueData.tier].color }}>
              {tierBadge[venueData.tier].label}
            </span>
          </div>
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.home('white', 24)}
            </div>
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Welcome, {venueData.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Venue Dashboard</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', flexShrink: 0 }}>
          {venueTabs.map(tab => (
            <button key={tab.id} onClick={() => setVenueTab(tab.id)} style={{ flex: 1, padding: '10px 4px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', borderBottom: venueTab === tab.id ? `2px solid ${colors.navy}` : '2px solid transparent', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
              {tab.icon(venueTab === tab.id ? colors.navy : '#9ca3af', 16)}
              <span style={{ fontSize: '9px', fontWeight: venueTab === tab.id ? '700' : '500', color: venueTab === tab.id ? colors.navy : '#9ca3af' }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* ANALYTICS TAB */}
          {venueTab === 'analytics' && (<>
          {/* Key Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Today's Check-ins</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.todayCheckins}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>This Week</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.weekTraffic}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Crowd Forecast</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: venueData.crowdForecast > 70 ? colors.red : colors.teal, margin: '4px 0 0' }}>{venueData.crowdForecast}%</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Repeat Rate</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.repeatRate}%</p>
              {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 20)}</div>}
            </div>
          </div>

          {/* Demographics */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Customer Demographics</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '60px' }}>
              {Object.entries(venueData.demographics).map(([age, pct]) => (
                <div key={age} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${pct * 0.6}px`, backgroundColor: colors.navy, borderRadius: '4px 4px 0 0' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{age}</span>
                  <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{pct}%</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Pro Feature</span></div>}
          </div>

          {/* Post a Deal */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 14)} Post a Deal</h3>
            <input
              type="text"
              value={dealDescription}
              onChange={(e) => setDealDescription(e.target.value)}
              placeholder="e.g., 2-for-1 drinks until 8pm"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '12px', marginBottom: '8px', boxSizing: 'border-box' }}
              disabled={isFeatureLocked('Post deals')}
            />
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {['Happy Hour', 'Late Night', 'Weekend', 'All Day'].map(slot => (
                <button key={slot} onClick={() => setDealTimeSlot(slot)} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${dealTimeSlot === slot ? colors.navy : colors.creamDark}`, backgroundColor: dealTimeSlot === slot ? colors.navy : 'white', color: dealTimeSlot === slot ? 'white' : colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals')}>
                  {slot}
                </button>
              ))}
            </div>
            <button onClick={() => { showToast('Deal posted!'); setDealDescription(''); }} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals') || !dealDescription.trim()}>
              Post Deal
            </button>
            {isFeatureLocked('Post deals') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Peak Hours */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Peak Hours (Tonight)</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '50px' }}>
              {venueData.peakHours.map((h, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${h.value * 0.5}px`, backgroundColor: h.value > 80 ? colors.red : h.value > 50 ? colors.amber : colors.teal, borderRadius: '2px', transition: 'all 0.3s' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{h.hour}</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Basic analytics') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Top Interests */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Top Visitor Interests</h3>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {venueData.topInterests.map(interest => (
                <span key={interest} style={{ padding: '6px 12px', borderRadius: '16px', backgroundColor: colors.cream, fontSize: '11px', fontWeight: '500', color: colors.navy }}>
                  {interest}
                </span>
              ))}
            </div>
          </div>

          {/* Upgrade Button (if not Pro) */}
          {venueTier !== 'pro' && (
            <button onClick={() => setShowUpgradeModal(true)} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: 'linear-gradient(135deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' }}>
              {Icons.sparkles('white', 18)} Upgrade to {venueTier === 'free' ? 'Premium' : 'Pro'}
            </button>
          )}
          </>)}

          {/* PROMOTIONS TAB */}
          {venueTab === 'promotions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create New Promotion Button */}
              <button onClick={() => openPromoModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Promotion
              </button>

              {/* Active Promotions */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Active Promotions ({promotions.length})</h3>
                {promotions.length === 0 ? (
                  <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No promotions yet. Create your first one!</p>
                ) : promotions.map(promo => (
                  <div key={promo.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{promo.title}</h4>
                        <p style={{ fontSize: '11px', color: '#6b7280', margin: '2px 0' }}>{promo.desc}</p>
                        <p style={{ fontSize: '10px', color: '#9ca3af', margin: 0 }}>{promo.time} - {promo.days}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => openPromoModal(promo)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        <button onClick={() => deletePromo(promo.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.eye('#6b7280', 12)}
                        <span style={{ fontSize: '10px', color: '#6b7280' }}>{promo.views} views</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {Icons.checkCircle(colors.teal, 12)}
                        <span style={{ fontSize: '10px', color: '#6b7280' }}>{promo.claims} claims</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Promotion Tips */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.sparkles(colors.amber, 12)} Pro Tips</h4>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#6b7280' }}>
                  <li>Happy Hour promos get 3x more engagement</li>
                  <li>Add specific discounts for better conversion</li>
                  <li>Weekend promos should be posted by Thursday</li>
                </ul>
              </div>
            </div>
          )}

          {/* EVENTS TAB */}
          {venueTab === 'events' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Create Event Button */}
              <button onClick={() => openEventModal()} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.plus('white', 18)} Create Event
              </button>

              {/* Incoming Flocks */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.teal, 14)} Incoming Flocks</h3>
                {incomingFlocks.length > 0 ? incomingFlocks.map(flock => (
                  <div key={flock.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{flock.name}</h4>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>{flock.members} members - {flock.time}</p>
                      </div>
                      <span style={{ padding: '4px 8px', borderRadius: '12px', backgroundColor: flock.status === 'confirmed' ? colors.teal : colors.amber, color: 'white', fontSize: '9px', fontWeight: '600' }}>
                        {flock.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                      </span>
                    </div>
                  </div>
                )) : <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No incoming flocks scheduled</p>}
              </div>

              {/* Your Events */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.calendar(colors.navy, 14)} Your Events ({venueEventsList.length})</h3>
                {venueEventsList.length === 0 ? (
                  <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center', padding: '20px' }}>No events yet. Create your first one!</p>
                ) : venueEventsList.map(event => (
                  <div key={event.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <h4 style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{event.title}</h4>
                        <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>{event.date} at {event.time}</p>
                        <p style={{ fontSize: '10px', color: '#9ca3af', margin: 0 }}>{event.rsvps}/{event.capacity} RSVPs</p>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button onClick={() => openEventModal(event)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.edit(colors.navy, 14)}</button>
                        <button onClick={() => deleteEvent(event.id)} style={{ padding: '6px', borderRadius: '6px', border: 'none', backgroundColor: 'white', cursor: 'pointer' }}>{Icons.trash(colors.red, 14)}</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Event Calendar Preview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>This Week</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px', textAlign: 'center' }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <div key={i} style={{ fontSize: '9px', fontWeight: '600', color: '#9ca3af', padding: '4px' }}>{d}</div>
                  ))}
                  {[19, 20, 21, 22, 23, 24, 25].map((day, i) => (
                    <div key={day} style={{ padding: '8px 4px', borderRadius: '6px', backgroundColor: i === 5 || i === 6 ? colors.navy : 'transparent', color: i === 5 || i === 6 ? 'white' : colors.navy, fontSize: '11px', fontWeight: '600' }}>
                      {day}
                      {(i === 5 || i === 6) && <div style={{ width: '4px', height: '4px', borderRadius: '2px', backgroundColor: colors.amber, margin: '2px auto 0' }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* REVIEWS TAB */}
          {venueTab === 'reviews' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Rating Overview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: '32px', fontWeight: '900', color: colors.navy, margin: 0 }}>4.7</p>
                    <div style={{ display: 'flex', gap: '2px', justifyContent: 'center', margin: '4px 0' }}>
                      {[1, 2, 3, 4, 5].map(s => s <= 4 ? Icons.starFilled(colors.amber, 14) : Icons.star(colors.amber, 14))}
                    </div>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>156 reviews</p>
                  </div>
                  <div style={{ flex: 1 }}>
                    {[5, 4, 3, 2, 1].map(rating => (
                      <div key={rating} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '10px', color: '#6b7280', width: '12px' }}>{rating}</span>
                        <div style={{ flex: 1, height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${rating === 5 ? 60 : rating === 4 ? 25 : rating === 3 ? 10 : rating === 2 ? 3 : 2}%`, backgroundColor: colors.amber, borderRadius: '3px' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Recent Reviews */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Reviews</h3>
                {reviews.map(review => (
                  <div key={review.id} style={{ padding: '10px', backgroundColor: colors.cream, borderRadius: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                          {review.user.charAt(0)}
                        </div>
                        <div>
                          <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{review.user}</p>
                          <div style={{ display: 'flex', gap: '1px' }}>
                            {[1, 2, 3, 4, 5].map(s => s <= review.rating ? Icons.starFilled(colors.amber, 10) : Icons.star('#d1d5db', 10))}
                          </div>
                        </div>
                      </div>
                      <span style={{ fontSize: '9px', color: '#9ca3af' }}>{review.date}</span>
                    </div>
                    <p style={{ fontSize: '11px', color: '#4b5563', margin: '8px 0 0', lineHeight: '1.4' }}>{review.text}</p>
                    {!review.replied && (
                      <button onClick={() => showToast('Reply sent!')} style={{ marginTop: '8px', padding: '6px 10px', borderRadius: '6px', border: `1px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>
                        Reply
                      </button>
                    )}
                    {review.replied && <p style={{ fontSize: '10px', color: colors.teal, margin: '8px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.checkCircle(colors.teal, 12)} Replied</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SETTINGS TAB */}
          {venueTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Venue Info */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.building(colors.navy, 14)} Venue Information</h3>
                  {!editingVenueInfo ? (
                    <button onClick={() => setEditingVenueInfo(true)} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.cream, color: colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>Edit</button>
                  ) : (
                    <button onClick={() => { setEditingVenueInfo(false); showToast('Info saved!'); }} style={{ padding: '4px 8px', borderRadius: '6px', border: 'none', backgroundColor: colors.teal, color: 'white', fontSize: '10px', fontWeight: '500', cursor: 'pointer' }}>Save</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Venue Name</label>
                    <input type="text" value={venueInfo.name} onChange={(e) => setVenueInfo({...venueInfo, name: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Address</label>
                    <input type="text" value={venueInfo.address} onChange={(e) => setVenueInfo({...venueInfo, address: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Phone</label>
                    <input type="text" value={venueInfo.phone} onChange={(e) => setVenueInfo({...venueInfo, phone: e.target.value})} disabled={!editingVenueInfo} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${editingVenueInfo ? colors.navy : colors.creamDark}`, fontSize: '12px', boxSizing: 'border-box', backgroundColor: editingVenueInfo ? 'white' : colors.cream }} />
                  </div>
                </div>
              </div>

              {/* Operating Hours */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.clock(colors.navy, 14)} Operating Hours</h3>
                {operatingHours.map((slot, i) => (
                  <div key={slot.days} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < operatingHours.length - 1 ? `1px solid ${colors.cream}` : 'none' }}>
                    <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{slot.days}</span>
                    <span style={{ fontSize: '11px', color: '#6b7280' }}>{slot.open} - {slot.close}</span>
                  </div>
                ))}
                <button onClick={() => setShowHoursModal(true)} style={{ marginTop: '8px', width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontSize: '11px', fontWeight: '500', cursor: 'pointer' }}>
                  Edit Hours
                </button>
              </div>

              {/* Notification Settings */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.bell(colors.navy, 14)} Notifications</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>New bookings</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Get notified when a flock books</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, bookings: !notifications.bookings}); showToast(notifications.bookings ? 'Disabled' : 'Enabled'); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.bookings ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.bookings ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>New reviews</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Alerts for customer reviews</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, reviews: !notifications.reviews}); showToast(notifications.reviews ? 'Disabled' : 'Enabled'); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.reviews ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.reviews ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                  <div>
                    <p style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, margin: 0 }}>Weekly reports</p>
                    <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>Performance summary emails</p>
                  </div>
                  <div onClick={() => { setNotifications({...notifications, weekly: !notifications.weekly}); showToast(notifications.weekly ? 'Disabled' : 'Enabled'); }} style={{ width: '36px', height: '20px', borderRadius: '10px', backgroundColor: notifications.weekly ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative' }}>
                    <div style={{ position: 'absolute', top: '2px', left: notifications.weekly ? '18px' : '2px', width: '16px', height: '16px', borderRadius: '8px', backgroundColor: 'white', transition: 'left 0.2s' }} />
                  </div>
                </div>
              </div>

              {/* Subscription */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.creditCard(colors.navy, 14)} Subscription</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                  <div>
                    <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>{tierBadge[venueData.tier].label} Plan</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{venueTier === 'free' ? 'Free forever' : venueTier === 'premium' ? '$35/month' : '$75/month'}</p>
                  </div>
                  {venueTier !== 'pro' && (
                    <button onClick={() => setShowUpgradeModal(true)} style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', color: 'white', fontSize: '10px', fontWeight: '600', cursor: 'pointer' }}>
                      Upgrade
                    </button>
                  )}
                </div>
              </div>

              {/* Danger Zone */}
              <div style={{ backgroundColor: '#fef2f2', borderRadius: '12px', padding: '12px', border: '1px solid #fecaca' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.red, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.alertCircle(colors.red, 14)} Danger Zone</h3>
                <button onClick={() => showToast('Contact support to deactivate')} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: `1px solid ${colors.red}`, backgroundColor: 'white', color: colors.red, fontSize: '11px', fontWeight: '500', cursor: 'pointer' }}>
                  Deactivate Venue Listing
                </button>
              </div>
            </div>
          )}

          {/* Upgrade Modal */}
          {showUpgradeModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Choose Your Plan</h2>

                {/* Free Tier */}
                <div style={{ border: `2px solid ${venueTier === 'free' ? colors.navy : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: colors.navy }}>Free</span>
                    <span style={{ fontWeight: '900', color: colors.navy }}>$0/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.free.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'free' && <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: colors.teal, fontWeight: '600', marginTop: '8px' }}>Current Plan</span>}
                </div>

                {/* Premium Tier */}
                <div style={{ border: `2px solid ${venueTier === 'premium' ? '#b45309' : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px', backgroundColor: venueTier === 'premium' ? '#fffbeb' : 'white' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#b45309' }}>Premium</span>
                    <span style={{ fontWeight: '900', color: '#b45309' }}>$35/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.premium.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'premium' ? <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: '#b45309', fontWeight: '600', marginTop: '8px' }}>Current Plan</span> : venueTier === 'free' && <button onClick={() => { setVenueTier('premium'); setShowUpgradeModal(false); showToast('Upgraded to Premium!'); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', backgroundColor: '#b45309', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade</button>}
                </div>

                {/* Pro Tier */}
                <div style={{ border: '2px solid #7c3aed', borderRadius: '12px', padding: '12px', marginBottom: '16px', backgroundColor: '#faf5ff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#7c3aed' }}>Pro</span>
                    <span style={{ fontWeight: '900', color: '#7c3aed' }}>$75/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.pro.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  <button onClick={() => { setVenueTier('pro'); setShowUpgradeModal(false); showToast('Upgraded to Pro!'); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade to Pro</button>
                </div>

                <button onClick={() => setShowUpgradeModal(false)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '500', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}

          {/* Promotion Modal */}
          {showPromoModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>
                  {editingPromo ? 'Edit Promotion' : 'New Promotion'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Title</label>
                    <input type="text" value={promoForm.title} onChange={(e) => setPromoForm({...promoForm, title: e.target.value})} placeholder="e.g., Half-Price Apps" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Description</label>
                    <input type="text" value={promoForm.desc} onChange={(e) => setPromoForm({...promoForm, desc: e.target.value})} placeholder="e.g., 50% off all appetizers" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Time Slot</label>
                    <select value={promoForm.time} onChange={(e) => setPromoForm({...promoForm, time: e.target.value})} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box', backgroundColor: 'white' }}>
                      <option value="Happy Hour">Happy Hour (4-7pm)</option>
                      <option value="Late Night">Late Night (10pm-close)</option>
                      <option value="Weekend Brunch">Weekend Brunch (10am-2pm)</option>
                      <option value="All Day">All Day</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Days Active</label>
                    <select value={promoForm.days} onChange={(e) => setPromoForm({...promoForm, days: e.target.value})} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box', backgroundColor: 'white' }}>
                      <option value="Daily">Daily</option>
                      <option value="Weekdays">Weekdays</option>
                      <option value="Weekends">Weekends</option>
                      <option value="Mon-Fri">Mon-Fri</option>
                      <option value="Fri-Sun">Fri-Sun</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => { setShowPromoModal(false); setEditingPromo(null); setPromoForm({ title: '', desc: '', time: 'Happy Hour', days: 'Daily' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={savePromo} disabled={!promoForm.title || !promoForm.desc} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: promoForm.title && promoForm.desc ? colors.navy : '#d1d5db', color: 'white', fontWeight: '600', cursor: promoForm.title && promoForm.desc ? 'pointer' : 'not-allowed' }}>
                    {editingPromo ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Event Modal */}
          {showEventModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>
                  {editingEvent ? 'Edit Event' : 'New Event'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Event Title</label>
                    <input type="text" value={eventForm.title} onChange={(e) => setEventForm({...eventForm, title: e.target.value})} placeholder="e.g., Live Jazz Night" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Date</label>
                      <input type="text" value={eventForm.date} onChange={(e) => setEventForm({...eventForm, date: e.target.value})} placeholder="Jan 25" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Time</label>
                      <input type="text" value={eventForm.time} onChange={(e) => setEventForm({...eventForm, time: e.target.value})} placeholder="8:00 PM" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', fontWeight: '600', color: '#6b7280', display: 'block', marginBottom: '4px' }}>Capacity</label>
                    <input type="number" value={eventForm.capacity} onChange={(e) => setEventForm({...eventForm, capacity: e.target.value})} placeholder="50" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '13px', boxSizing: 'border-box' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => { setShowEventModal(false); setEditingEvent(null); setEventForm({ title: '', date: '', time: '', capacity: '' }); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={saveEvent} disabled={!eventForm.title || !eventForm.date || !eventForm.time} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: eventForm.title && eventForm.date && eventForm.time ? colors.navy : '#d1d5db', color: 'white', fontWeight: '600', cursor: eventForm.title && eventForm.date && eventForm.time ? 'pointer' : 'not-allowed' }}>
                    {editingEvent ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Hours Modal */}
          {showHoursModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '340px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Edit Operating Hours</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {operatingHours.map((slot, index) => (
                    <div key={slot.days} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, width: '70px' }}>{slot.days}</span>
                      <select value={slot.open} onChange={(e) => { const updated = [...operatingHours]; updated[index].open = e.target.value; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: '11px', backgroundColor: 'white' }}>
                        <option value="11:00 AM">11:00 AM</option>
                        <option value="12:00 PM">12:00 PM</option>
                        <option value="2:00 PM">2:00 PM</option>
                        <option value="4:00 PM">4:00 PM</option>
                        <option value="5:00 PM">5:00 PM</option>
                      </select>
                      <span style={{ fontSize: '11px', color: '#6b7280' }}>to</span>
                      <select value={slot.close} onChange={(e) => { const updated = [...operatingHours]; updated[index].close = e.target.value; setOperatingHours(updated); }} style={{ flex: 1, padding: '6px', borderRadius: '6px', border: `1px solid ${colors.creamDark}`, fontSize: '11px', backgroundColor: 'white' }}>
                        <option value="10:00 PM">10:00 PM</option>
                        <option value="11:00 PM">11:00 PM</option>
                        <option value="12:00 AM">12:00 AM</option>
                        <option value="1:00 AM">1:00 AM</option>
                        <option value="2:00 AM">2:00 AM</option>
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button onClick={() => setShowHoursModal(false)} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => { setShowHoursModal(false); showToast('Hours updated!'); }} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', backgroundColor: colors.navy, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Save Hours</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ADMIN DASHBOARD SCREEN
  const RevenueScreen = () => {
    // adminTab state is now at App level to persist across re-renders

    // Admin tabs definition
    const adminTabs = [
      { id: 'revenue', label: 'Revenue', icon: Icons.dollar },
      { id: 'users', label: 'Users', icon: Icons.users },
      { id: 'venues', label: 'Venues', icon: Icons.building },
      { id: 'cities', label: 'Cities', icon: Icons.map },
      { id: 'transactions', label: 'Txns', icon: Icons.creditCard },
      { id: 'projections', label: 'Project', icon: Icons.barChart }
    ];

    // Mock data for admin dashboard
    const adminUsers = [
      { id: 1, name: 'Emma Wilson', email: 'emma@email.com', joined: 'Jan 15', flocks: 11, status: 'active' },
      { id: 2, name: 'Jake Martinez', email: 'jake@email.com', joined: 'Jan 12', flocks: 4, status: 'active' },
      { id: 3, name: 'Sarah Chen', email: 'sarah@email.com', joined: 'Jan 10', flocks: 17, status: 'active' },
      { id: 4, name: 'Mike Johnson', email: 'mike@email.com', joined: 'Jan 8', flocks: 2, status: 'inactive' },
      { id: 5, name: 'Lisa Park', email: 'lisa@email.com', joined: 'Jan 5', flocks: 9, status: 'active' },
    ];

    const adminVenues = [
      { id: 1, name: "Blue Heron Bar", tier: 'pro', city: 'Easton', revenue: 2847, rating: 4.7 },
      { id: 2, name: "Porters Pub", tier: 'premium', city: 'Easton', revenue: 1923, rating: 4.6 },
      { id: 3, name: "The Bookstore Speakeasy", tier: 'free', city: 'Bethlehem', revenue: 487, rating: 4.4 },
      { id: 4, name: "Godfrey Daniels", tier: 'premium', city: 'Bethlehem', revenue: 1634, rating: 4.7 },
      { id: 5, name: "Rooftop @ The Grand", tier: 'pro', city: 'Easton', revenue: 2156, rating: 4.8 },
    ];

    const adminCities = [
      { name: 'Easton', users: 847, venues: 31, revenue: 14823, growth: 17 },
      { name: 'Bethlehem', users: 1089, venues: 38, revenue: 16247, growth: 14 },
      { name: 'Allentown', users: 623, venues: 19, revenue: 8934, growth: 11 },
    ];

    const adminTransactions = [
      { id: 'TXN-4821', date: 'Jan 19', venue: 'Blue Heron Bar', amount: 247, type: 'booking', status: 'completed' },
      { id: 'TXN-4820', date: 'Jan 19', venue: 'Porters Pub', amount: 175, type: 'subscription', status: 'completed' },
      { id: 'TXN-4819', date: 'Jan 18', venue: 'Godfrey Daniels', amount: 318, type: 'booking', status: 'pending' },
      { id: 'TXN-4818', date: 'Jan 18', venue: 'The Bookstore Speakeasy', amount: 75, type: 'subscription', status: 'completed' },
      { id: 'TXN-4817', date: 'Jan 17', venue: 'Rooftop @ The Grand', amount: 423, type: 'booking', status: 'completed' },
    ];

    // Revenue simulator state
    const [numVenues, setNumVenues] = useState(20);
    const [subscriptionPrice, setSubscriptionPrice] = useState(50);
    const [eventsPerVenue, setEventsPerVenue] = useState(12);
    const [avgSpend, setAvgSpend] = useState(120);
    const [takeRate, setTakeRate] = useState(2.5);
    const [operatingCosts, setOperatingCosts] = useState(2000);

    // Calculate all metrics
    const subscriptionRevenue = calculateSubscriptionRevenue(numVenues, subscriptionPrice);
    const transactionRevenue = calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate);
    const totalMonthlyRevenue = calculateTotalMonthlyRevenue(subscriptionRevenue, transactionRevenue);
    const annualRevenue = calculateAnnualRevenue(totalMonthlyRevenue);
    const monthlyProfit = calculateMonthlyProfit(totalMonthlyRevenue, operatingCosts);
    const revenuePerVenue = calculateRevenuePerVenue(totalMonthlyRevenue, numVenues);
    const breakEvenVenues = calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate);
    const profitMargin = calculateProfitMargin(monthlyProfit, totalMonthlyRevenue);
    const isProfitable = monthlyProfit >= 0;
    const isAboveBreakEven = numVenues >= breakEvenVenues;

    // Input field style
    const inputStyle = {
      width: '100%',
      padding: '10px 12px',
      borderRadius: '8px',
      border: `1px solid ${colors.creamDark}`,
      fontSize: '14px',
      fontWeight: '600',
      color: colors.navy,
      backgroundColor: 'white',
      outline: 'none',
      boxSizing: 'border-box',
    };

    const labelStyle = {
      fontSize: '11px',
      fontWeight: '700',
      color: colors.navy,
      marginBottom: '4px',
      display: 'block',
    };

    const helperStyle = {
      fontSize: '9px',
      color: '#9ca3af',
      marginTop: '2px',
    };

    const cardStyle = {
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '12px',
      marginBottom: '10px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    };

    return (
      <div key="revenue-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={switchMode} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            {Icons.briefcase('white', 24)}
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Admin Dashboard</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Manage your Flock platform</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div style={{ display: 'flex', backgroundColor: 'white', borderBottom: '1px solid #e5e7eb', flexShrink: 0, padding: '8px 4px', gap: '4px' }}>
          {adminTabs.map(tab => (
            <button key={tab.id} onClick={() => setAdminTab(tab.id)} style={{ flex: 1, padding: '12px 4px', border: 'none', backgroundColor: adminTab === tab.id ? colors.navy : colors.cream, borderRadius: '10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', transition: 'all 0.2s' }}>
              {tab.icon(adminTab === tab.id ? 'white' : colors.navy, 18)}
              <span style={{ fontSize: '10px', fontWeight: '700', color: adminTab === tab.id ? 'white' : colors.navy }}>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

          {/* REVENUE TAB */}
          {adminTab === 'revenue' && (<>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

            {/* LEFT COLUMN - INPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inputs</h3>

              {/* Number of Venues */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Number of Venues</label>
                <input
                  type="number"
                  value={numVenues}
                  onChange={(e) => setNumVenues(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Venues subscribed to Flock</p>
              </div>

              {/* Subscription Price */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Subscription</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={subscriptionPrice}
                    onChange={(e) => setSubscriptionPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Monthly fee per venue</p>
              </div>

              {/* Events Per Venue */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Events Per Venue/Month</label>
                <input
                  type="number"
                  value={eventsPerVenue}
                  onChange={(e) => setEventsPerVenue(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Avg bookings per venue</p>
              </div>

              {/* Average Spend */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Avg Group Spend</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={avgSpend}
                    onChange={(e) => setAvgSpend(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Per event transaction</p>
              </div>

              {/* Take Rate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Transaction Take Rate</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    value={takeRate}
                    onChange={(e) => setTakeRate(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingRight: '28px' }}
                    min="0"
                    step="0.1"
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>%</span>
                </div>
                <p style={helperStyle}>% of each transaction</p>
              </div>

              {/* Operating Costs */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Operating Costs</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={operatingCosts}
                    onChange={(e) => setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Fixed monthly expenses</p>
              </div>
            </div>

            {/* RIGHT COLUMN - OUTPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Results</h3>

              {/* Revenue Breakdown */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Revenue Breakdown</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Subscriptions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(subscriptionRevenue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Transactions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(transactionRevenue)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${colors.creamDark}`, paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navy }}>Monthly Total</span>
                    <span style={{ fontSize: '18px', fontWeight: '900', color: colors.navy }}>{formatCurrency(totalMonthlyRevenue)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#6b7280' }}>Annual (ARR)</span>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navyMid }}>{formatCurrency(annualRevenue)}</span>
                  </div>
                </div>
              </div>

              {/* Profitability */}
              <div style={{ ...cardStyle, background: isProfitable ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)' : 'linear-gradient(135deg, #fee2e2, #fecaca)' }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c', margin: '0 0 8px', textTransform: 'uppercase' }}>
                  {isProfitable ? 'Profitable' : 'Not Profitable'}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: isProfitable ? '#065f46' : '#991b1b' }}>Monthly Profit</span>
                  <span style={{ fontSize: '16px', fontWeight: '900', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {monthlyProfit >= 0 ? '+' : ''}{formatCurrency(monthlyProfit)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: '10px', color: isProfitable ? '#065f46' : '#991b1b' }}>Profit Margin</span>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {profitMargin.toFixed(1)}%
                  </span>
                </div>
              </div>

              {/* Unit Economics */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Unit Economics</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Revenue/Venue</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(revenuePerVenue)}/mo</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Break-Even Point</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{breakEvenVenues} venues</span>
                </div>
                <div style={{ padding: '8px', borderRadius: '8px', backgroundColor: isAboveBreakEven ? '#d1fae5' : '#fef3c7', textAlign: 'center' }}>
                  <span style={{ fontSize: '10px', fontWeight: '700', color: isAboveBreakEven ? '#047857' : '#b45309' }}>
                    {isAboveBreakEven
                      ? `${numVenues - breakEvenVenues} venues above break-even`
                      : `Need ${breakEvenVenues - numVenues} more venues`}
                  </span>
                </div>
              </div>

              {/* Business Model Info */}
              <div style={{ ...cardStyle, backgroundColor: colors.cream, border: `1px solid ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: colors.navy, margin: '0 0 6px' }}>Business Model</h4>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>
                  Flock generates revenue through <strong>venue subscriptions</strong> (recurring, predictable)
                  and <strong>transaction fees</strong> (scales with activity). This dual-revenue model provides
                  stability while capturing upside from platform growth.
                </p>
              </div>
            </div>
          </div>
          </>)}

          {/* USERS TAB */}
          {adminTab === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* User Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: 0 }}>3,200</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Users</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.teal, margin: 0 }}>2,850</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Active</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.amber, margin: 0 }}>+156</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>This Week</p>
                </div>
              </div>

              {/* User Growth Chart */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>User Growth (Last 7 Days)</h3>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '60px' }}>
                  {[45, 52, 38, 65, 78, 92, 110].map((val, i) => (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <div style={{ width: '100%', height: `${val * 0.5}px`, backgroundColor: colors.navy, borderRadius: '4px 4px 0 0', minHeight: '4px' }} />
                      <span style={{ fontSize: '8px', color: '#9ca3af', marginTop: '4px' }}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'][i]}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Users */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Users</h3>
                {adminUsers.map(user => (
                  <div key={user.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '12px', fontWeight: '700' }}>
                        {user.name.charAt(0)}
                      </div>
                      <div>
                        <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{user.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{user.email}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: user.status === 'active' ? '#d1fae5' : '#fef3c7', color: user.status === 'active' ? '#047857' : '#b45309', fontSize: '9px', fontWeight: '600' }}>
                        {user.status}
                      </span>
                      <p style={{ fontSize: '9px', color: '#9ca3af', margin: '4px 0 0' }}>{user.flocks} flocks</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* VENUES TAB */}
          {adminTab === 'venues' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Venue Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: 0 }}>117</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Venues</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: '#7c3aed', margin: 0 }}>28</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Pro Tier</p>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '24px', fontWeight: '900', color: '#b45309', margin: 0 }}>45</p>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Premium</p>
                </div>
              </div>

              {/* Tier Distribution */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Tier Distribution</h3>
                <div style={{ display: 'flex', height: '12px', borderRadius: '6px', overflow: 'hidden' }}>
                  <div style={{ width: '24%', backgroundColor: '#7c3aed' }} title="Pro" />
                  <div style={{ width: '38%', backgroundColor: '#b45309' }} title="Premium" />
                  <div style={{ width: '38%', backgroundColor: '#9ca3af' }} title="Free" />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
                  <span style={{ fontSize: '9px', color: '#7c3aed', fontWeight: '600' }}>Pro 24%</span>
                  <span style={{ fontSize: '9px', color: '#b45309', fontWeight: '600' }}>Premium 38%</span>
                  <span style={{ fontSize: '9px', color: '#9ca3af', fontWeight: '600' }}>Free 38%</span>
                </div>
              </div>

              {/* Venue List */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Top Venues</h3>
                {adminVenues.map(venue => (
                  <div key={venue.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: venue.tier === 'pro' ? '#7c3aed' : venue.tier === 'premium' ? '#b45309' : colors.navy, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {Icons.building('white', 16)}
                      </div>
                      <div>
                        <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{venue.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{venue.city} • {venue.rating} {Icons.starFilled(colors.amber, 10)}</p>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${venue.revenue}</p>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: venue.tier === 'pro' ? '#faf5ff' : venue.tier === 'premium' ? '#fffbeb' : colors.cream, color: venue.tier === 'pro' ? '#7c3aed' : venue.tier === 'premium' ? '#b45309' : '#6b7280', fontSize: '9px', fontWeight: '600' }}>
                        {venue.tier}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CITIES TAB */}
          {adminTab === 'cities' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* City Overview */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.map(colors.navy, 14)} Market Overview</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ backgroundColor: colors.cream, borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                    <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>4</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Active Cities</p>
                  </div>
                  <div style={{ backgroundColor: colors.cream, borderRadius: '8px', padding: '10px', textAlign: 'center' }}>
                    <p style={{ fontSize: '20px', fontWeight: '900', color: colors.teal, margin: 0 }}>$44.8K</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>Total Revenue</p>
                  </div>
                </div>
              </div>

              {/* City Performance */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>City Performance</h3>
                {adminCities.map((city, i) => (
                  <div key={city.name} style={{ padding: '10px 0', borderBottom: i < adminCities.length - 1 ? `1px solid ${colors.cream}` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <div>
                        <p style={{ fontSize: '13px', fontWeight: '700', color: colors.navy, margin: 0 }}>{city.name}</p>
                        <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{city.users} users • {city.venues} venues</p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${(city.revenue / 1000).toFixed(1)}K</p>
                        <span style={{ fontSize: '9px', color: colors.teal, fontWeight: '600' }}>+{city.growth}%</span>
                      </div>
                    </div>
                    <div style={{ height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(city.revenue / 18500) * 100}%`, backgroundColor: colors.navy, borderRadius: '3px' }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Expansion Opportunities */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.globe(colors.teal, 12)} Expansion Targets</h4>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {['Denver', 'Phoenix', 'Nashville', 'Atlanta'].map(city => (
                    <span key={city} style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: 'white', fontSize: '10px', fontWeight: '500', color: colors.navy }}>
                      {city}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TRANSACTIONS TAB */}
          {adminTab === 'transactions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Transaction Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: '0 0 4px', textTransform: 'uppercase' }}>Today's Volume</p>
                  <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>$3,240</p>
                  <span style={{ fontSize: '10px', color: colors.teal }}>+18% vs yesterday</span>
                </div>
                <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <p style={{ fontSize: '9px', color: '#6b7280', margin: '0 0 4px', textTransform: 'uppercase' }}>This Month</p>
                  <p style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>$48.2K</p>
                  <span style={{ fontSize: '10px', color: colors.teal }}>+12% vs last month</span>
                </div>
              </div>

              {/* Transaction Type Breakdown */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>By Type</h3>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <div style={{ flex: 1, textAlign: 'center', padding: '10px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                    <p style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: 0 }}>68%</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: '4px 0 0' }}>Bookings</p>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center', padding: '10px', backgroundColor: colors.cream, borderRadius: '8px' }}>
                    <p style={{ fontSize: '16px', fontWeight: '900', color: colors.navy, margin: 0 }}>32%</p>
                    <p style={{ fontSize: '9px', color: '#6b7280', margin: '4px 0 0' }}>Subscriptions</p>
                  </div>
                </div>
              </div>

              {/* Recent Transactions */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Recent Transactions</h3>
                {adminTransactions.map(txn => (
                  <div key={txn.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div>
                      <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>{txn.venue}</p>
                      <p style={{ fontSize: '9px', color: '#9ca3af', margin: 0 }}>{txn.id} • {txn.date}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: 0 }}>${txn.amount}</p>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' }}>
                        <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: txn.type === 'booking' ? '#dbeafe' : '#fce7f3', color: txn.type === 'booking' ? '#1d4ed8' : '#be185d', fontSize: '8px', fontWeight: '600' }}>
                          {txn.type}
                        </span>
                        <span style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: txn.status === 'completed' ? colors.teal : colors.amber }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PROJECTIONS TAB */}
          {adminTab === 'projections' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Growth Projections */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.barChart(colors.navy, 14)} 12-Month Projection</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
                  {['Q1', 'Q2', 'Q3', 'Q4'].map((q, i) => (
                    <div key={q} style={{ textAlign: 'center' }}>
                      <div style={{ height: `${40 + i * 20}px`, backgroundColor: colors.navy, borderRadius: '4px', marginBottom: '4px', opacity: 0.3 + i * 0.2 }} />
                      <p style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, margin: 0 }}>{q}</p>
                      <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>${[52, 78, 112, 156][i]}K</p>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '8px', backgroundColor: '#d1fae5', borderRadius: '8px', textAlign: 'center' }}>
                  <p style={{ fontSize: '10px', fontWeight: '700', color: '#047857', margin: 0 }}>Projected ARR: $624K (+200% YoY)</p>
                </div>
              </div>

              {/* Key Metrics Forecast */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>EOY Targets</h3>
                {[
                  { metric: 'Total Users', current: '3,200', target: '15,000', progress: 21 },
                  { metric: 'Active Venues', current: '117', target: '500', progress: 23 },
                  { metric: 'Cities', current: '4', target: '12', progress: 33 },
                  { metric: 'Monthly Revenue', current: '$18K', target: '$52K', progress: 35 },
                ].map(item => (
                  <div key={item.metric} style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{item.metric}</span>
                      <span style={{ fontSize: '10px', color: '#6b7280' }}>{item.current} / {item.target}</span>
                    </div>
                    <div style={{ height: '6px', backgroundColor: colors.cream, borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${item.progress}%`, backgroundColor: colors.teal, borderRadius: '3px' }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Growth Levers */}
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Growth Levers</h3>
                {[
                  { lever: 'Venue Acquisition', impact: 'High', effort: 'Medium', icon: Icons.building },
                  { lever: 'User Referrals', impact: 'High', effort: 'Low', icon: Icons.users },
                  { lever: 'City Expansion', impact: 'Very High', effort: 'High', icon: Icons.globe },
                  { lever: 'Premium Upsells', impact: 'Medium', effort: 'Low', icon: Icons.sparkles },
                ].map(item => (
                  <div key={item.lever} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${colors.cream}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {item.icon(colors.navy, 14)}
                      <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy }}>{item.lever}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: item.impact === 'Very High' ? '#d1fae5' : item.impact === 'High' ? '#dbeafe' : '#fef3c7', color: item.impact === 'Very High' ? '#047857' : item.impact === 'High' ? '#1d4ed8' : '#b45309', fontSize: '8px', fontWeight: '600' }}>
                        {item.impact}
                      </span>
                      <span style={{ padding: '2px 6px', borderRadius: '8px', backgroundColor: colors.cream, color: '#6b7280', fontSize: '8px', fontWeight: '500' }}>
                        {item.effort}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Strategic Notes */}
              <div style={{ backgroundColor: colors.cream, borderRadius: '12px', padding: '12px', border: `1px dashed ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '11px', fontWeight: '700', color: colors.navy, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.sparkles(colors.amber, 12)} Key Insights</h4>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#6b7280' }}>
                  <li>Austin market nearing saturation - prioritize Dallas/Houston</li>
                  <li>Pro tier conversion at 24% - above industry average</li>
                  <li>User acquisition cost trending down 15% MoM</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ONBOARDING SCREEN
  const vibeOptions = [
    { icon: Icons.cocktail, label: 'Cocktails' },
    { icon: Icons.music, label: 'Live Music' },
    { icon: Icons.beer, label: 'Beer & Brews' },
    { icon: Icons.sports, label: 'Sports' },
    { icon: Icons.partyPopper, label: 'Dancing' },
    { icon: Icons.mic, label: 'Karaoke' },
    { icon: Icons.laugh, label: 'Comedy' },
    { icon: Icons.wine, label: 'Wine' },
    { icon: Icons.gamepad, label: 'Gaming' },
    { icon: Icons.palette, label: 'Art & Culture' },
    { icon: Icons.pizza, label: 'Food' },
    { icon: Icons.coffee, label: 'Chill Vibes' },
  ];

  const completeOnboarding = () => {
    setOnboardingAnimating(true);
    setTimeout(() => {
      localStorage.setItem('flockOnboardingComplete', 'true');
      if (onboardingName.trim()) {
        setProfileName(onboardingName.trim());
      }
      if (onboardingVibes.length > 0) {
        setUserInterests(onboardingVibes);
      }
      setHasCompletedOnboarding(true);
      setOnboardingAnimating(false);
      showToast(`Welcome to the flock, ${onboardingName || 'friend'}!`);
    }, 1500);
  };

  const nextOnboardingStep = () => {
    setOnboardingAnimating(true);
    setTimeout(() => {
      setOnboardingStep(prev => prev + 1);
      setOnboardingAnimating(false);
    }, 300);
  };

  const OnboardingScreen = () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: `linear-gradient(180deg, ${colors.cream} 0%, white 100%)`,
      overflow: 'hidden',
      position: 'relative'
    }}>
      {/* Decorative background circles */}
      <div style={{ position: 'absolute', top: '-100px', right: '-100px', width: '250px', height: '250px', borderRadius: '50%', background: `linear-gradient(135deg, ${colors.navy}10, ${colors.navyMid}05)`, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '-50px', left: '-50px', width: '150px', height: '150px', borderRadius: '50%', background: `linear-gradient(135deg, ${colors.teal}10, ${colors.teal}05)`, pointerEvents: 'none' }} />

      {/* Progress indicator */}
      <div style={{ padding: '24px 24px 0', flexShrink: 0, position: 'relative', zIndex: 1 }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[0, 1, 2, 3].map(step => (
            <div
              key={step}
              style={{
                flex: 1,
                height: '4px',
                borderRadius: '4px',
                backgroundColor: step <= onboardingStep ? colors.navy : 'rgba(13,40,71,0.1)',
                transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
                transform: step <= onboardingStep ? 'scaleY(1.2)' : 'scaleY(1)'
              }}
            />
          ))}
        </div>
        <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '8px', textAlign: 'center' }}>Step {onboardingStep + 1} of 4</p>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 24px 24px',
        opacity: onboardingAnimating ? 0 : 1,
        transform: onboardingAnimating ? 'translateX(20px)' : 'translateX(0)',
        transition: 'opacity 0.3s, transform 0.3s',
        position: 'relative',
        zIndex: 1
      }}>
        {/* Step 0: Welcome */}
        {onboardingStep === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
            <div style={{
              width: '120px',
              height: '120px',
              borderRadius: '36px',
              background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyMid} 100%)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '32px',
              boxShadow: '0 20px 60px rgba(13,40,71,0.35)',
              position: 'relative'
            }}>
              {Icons.users('white', 56)}
              <div style={{ position: 'absolute', top: '-8px', right: '-8px', width: '32px', height: '32px', borderRadius: '50%', backgroundColor: colors.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(20,184,166,0.4)' }}>
                {Icons.sparkles('white', 16)}
              </div>
            </div>
            <h1 style={{ fontSize: '32px', fontWeight: '900', color: colors.navy, margin: '0 0 12px', letterSpacing: '-0.5px' }}>
              Welcome to Flock
            </h1>
            <p style={{ fontSize: '16px', color: colors.navyMid, margin: '0 0 8px', lineHeight: 1.5, fontWeight: '500' }}>
              Where plans come together.
            </p>
            <p style={{ fontSize: '14px', color: '#6b7280', margin: '0 0 48px', lineHeight: 1.6, maxWidth: '260px' }}>
              Coordinate nights out, discover venues, and rally your crew in seconds.
            </p>
            <button
              onClick={nextOnboardingStep}
              style={{ ...styles.gradientButton, maxWidth: '280px', padding: '16px 32px', fontSize: '15px' }}
            >
              Get Started →
            </button>
          </div>
        )}

        {/* Step 1: Name */}
        {onboardingStep === 1 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '20px', marginBottom: '32px' }}>
              <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(13,40,71,0.25)' }}>
                {Icons.user('white', 28)}
              </div>
              <div>
                <h1 style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '0 0 4px' }}>
                  What's your name?
                </h1>
                <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>
                  This is how friends will see you
                </p>
              </div>
            </div>
            <div style={{ position: 'relative', marginBottom: '12px' }}>
              <input
                type="text"
                value={onboardingName}
                onChange={(e) => setOnboardingName(e.target.value)}
                placeholder="Enter your name"
                style={{
                  ...styles.input,
                  fontSize: '18px',
                  padding: '20px 24px',
                  paddingLeft: '56px',
                  borderRadius: '16px',
                  border: `2px solid ${onboardingName.trim() ? colors.navy : colors.creamDark}`,
                  transition: 'border-color 0.2s'
                }}
                autoFocus
              />
              <div style={{ position: 'absolute', left: '18px', top: '50%', transform: 'translateY(-50%)' }}>
                {Icons.edit(onboardingName.trim() ? colors.navy : '#9ca3af', 20)}
              </div>
            </div>
            <p style={{ fontSize: '12px', color: '#9ca3af', margin: '0 0 auto', paddingLeft: '4px' }}>
              You can change this anytime in settings
            </p>
            <button
              onClick={nextOnboardingStep}
              disabled={!onboardingName.trim()}
              style={{
                ...styles.gradientButton,
                padding: '16px 32px',
                fontSize: '15px',
                opacity: onboardingName.trim() ? 1 : 0.5,
                cursor: onboardingName.trim() ? 'pointer' : 'not-allowed'
              }}
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 2: Vibes */}
        {onboardingStep === 2 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '12px', marginBottom: '24px' }}>
              <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: `linear-gradient(135deg, ${colors.teal}, #0d9488)`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(20,184,166,0.3)' }}>
                {Icons.heart('white', 28)}
              </div>
              <div>
                <h1 style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '0 0 4px' }}>
                  What's your vibe?
                </h1>
                <p style={{ fontSize: '13px', color: '#6b7280', margin: 0 }}>
                  Pick what you're into
                </p>
              </div>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '10px',
              flex: 1,
              overflow: 'auto',
              alignContent: 'start',
              marginBottom: '12px',
              paddingRight: '4px'
            }}>
              {vibeOptions.map(vibe => {
                const isSelected = onboardingVibes.includes(vibe.label);
                return (
                  <button
                    key={vibe.label}
                    onClick={() => {
                      if (isSelected) {
                        setOnboardingVibes(prev => prev.filter(v => v !== vibe.label));
                      } else {
                        setOnboardingVibes(prev => [...prev, vibe.label]);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '12px 16px',
                      borderRadius: '100px',
                      border: `2px solid ${isSelected ? colors.navy : colors.creamDark}`,
                      backgroundColor: isSelected ? colors.navy : 'white',
                      color: isSelected ? 'white' : colors.navy,
                      fontSize: '14px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      transform: isSelected ? 'scale(1.02)' : 'scale(1)'
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{vibe.icon(isSelected ? 'white' : colors.navy, 18)}</span>
                    {vibe.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '12px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: onboardingVibes.length > 0 ? colors.teal : '#d1d5db' }} />
              <p style={{ fontSize: '13px', color: onboardingVibes.length > 0 ? colors.teal : '#9ca3af', margin: 0, fontWeight: '600' }}>
                {onboardingVibes.length === 0
                  ? 'Select at least one'
                  : `${onboardingVibes.length} selected`}
              </p>
            </div>
            <button
              onClick={nextOnboardingStep}
              disabled={onboardingVibes.length === 0}
              style={{
                ...styles.gradientButton,
                padding: '16px 32px',
                fontSize: '15px',
                opacity: onboardingVibes.length > 0 ? 1 : 0.5,
                cursor: onboardingVibes.length > 0 ? 'pointer' : 'not-allowed'
              }}
            >
              Continue →
            </button>
          </div>
        )}

        {/* Step 3: All set */}
        {onboardingStep === 3 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
            <div style={{ position: 'relative', marginBottom: '32px' }}>
              <div style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #22C55E, #16A34A)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 20px 60px rgba(34,197,94,0.35)'
              }}>
                {Icons.check('white', 56)}
              </div>
              <div style={{ position: 'absolute', top: '-4px', right: '-4px', width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.amber, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(245,158,11,0.4)' }}>
                {Icons.sparkles('white', 18)}
              </div>
            </div>
            <h1 style={{ fontSize: '28px', fontWeight: '900', color: colors.navy, margin: '0 0 8px', letterSpacing: '-0.5px' }}>
              You're all set, {onboardingName || 'friend'}!
            </h1>
            <p style={{ fontSize: '16px', color: colors.navyMid, margin: '0 0 12px', lineHeight: 1.5, fontWeight: '500' }}>
              Time to find your flock.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginBottom: '32px', maxWidth: '280px' }}>
              {onboardingVibes.slice(0, 4).map(vibe => (
                <span key={vibe} style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'rgba(13,40,71,0.08)', color: colors.navy, fontSize: '12px', fontWeight: '600' }}>{vibe}</span>
              ))}
              {onboardingVibes.length > 4 && <span style={{ padding: '6px 12px', borderRadius: '20px', backgroundColor: 'rgba(13,40,71,0.08)', color: colors.navy, fontSize: '12px', fontWeight: '600' }}>+{onboardingVibes.length - 4} more</span>}
            </div>
            <button
              onClick={completeOnboarding}
              disabled={onboardingAnimating}
              style={{
                ...styles.gradientButton,
                maxWidth: '280px',
                padding: '16px 32px',
                fontSize: '15px',
                opacity: onboardingAnimating ? 0.7 : 1
              }}
            >
              {onboardingAnimating ? 'Getting things ready...' : "Let's Flock →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // RENDER - Call functions directly instead of JSX to prevent component recreation
  const renderScreen = () => {
    // Show welcome screen for mode selection
    if (showModeSelection) return <WelcomeScreen />;
    // Show onboarding for new users
    if (userMode === 'user' && !hasCompletedOnboarding) return <OnboardingScreen />;
    if (currentScreen === 'create') return CreateScreen();
    if (currentScreen === 'join') return JoinScreen();
    if (currentScreen === 'detail') return FlockDetailScreen();
    if (currentScreen === 'chatDetail') return ChatDetailScreen();
    if (currentScreen === 'dmDetail') return dmDetailScreen;
    if (currentScreen === 'venueDashboard') return <VenueDashboard />;
    if (currentScreen === 'adminRevenue') return <RevenueScreen />;
    switch (currentTab) {
      case 'explore': return ExploreScreen();
      case 'calendar': return CalendarScreen();
      case 'chat': return ChatListScreen();
      case 'profile': return ProfileScreen();
      default: return HomeScreen();
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={styles.phoneContainer}>
        <div style={styles.notch}>
          <div style={styles.notchInner} />
        </div>
        <div style={styles.content}>
          {renderScreen()}
        </div>
      </div>
      <Toast />
      <SOSModal />
      <CheckinModal />
      <ProfilePicModal />
      {aiAssistantModal}
      {adminPromptModal}
      <NewDmModal />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.8; transform: translate(-50%, -50%) scale(1.2); }
        }
        @keyframes heatPulseOuter {
          0%, 100% { opacity: 0.3; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.6; transform: translate(-50%, -50%) scale(1.15); }
        }
        @keyframes heatPulseMiddle {
          0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.7; transform: translate(-50%, -50%) scale(1.12); }
        }
        @keyframes heatPulseInner {
          0%, 100% { opacity: 0.5; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.85; transform: translate(-50%, -50%) scale(1.08); }
        }
        @keyframes heatPulseCore {
          0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); }
        }
        @keyframes heatGlow {
          0%, 100% { opacity: 0.8; filter: blur(0px); }
          50% { opacity: 1; filter: blur(2px); }
        }
        @keyframes trendingBounce {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-2px) rotate(-5deg); }
          75% { transform: translateY(-2px) rotate(5deg); }
        }
        @keyframes pinRingPulse {
          0% { opacity: 0.6; transform: translateX(-50%) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) scale(1.8); }
        }
        @keyframes tooltipFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(4px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes userLocationPulse {
          0% { opacity: 0.8; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(2.5); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 5px rgba(13,40,71,0.3); }
          50% { box-shadow: 0 0 20px rgba(13,40,71,0.5); }
        }
        @keyframes tabBounce {
          0% { transform: scale(1); }
          25% { transform: scale(0.9); }
          50% { transform: scale(1.15); }
          75% { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        @keyframes cardSlideIn {
          from { opacity: 0; transform: translateY(20px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes buttonPress {
          0% { transform: scale(1); }
          50% { transform: scale(0.95); }
          100% { transform: scale(1); }
        }
        @keyframes ripple {
          0% { transform: scale(0); opacity: 0.5; }
          100% { transform: scale(4); opacity: 0; }
        }
        @keyframes reactionPop {
          0% { transform: scale(0); }
          50% { transform: scale(1.4); }
          75% { transform: scale(0.9); }
          100% { transform: scale(1); }
        }
        @keyframes typingDot {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-6px); }
        }
        @keyframes toastSlideIn {
          from { transform: translateY(-100%) scale(0.9); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes toastSlideOut {
          from { transform: translateY(0) scale(1); opacity: 1; }
          to { transform: translateY(-100%) scale(0.9); opacity: 0; }
        }
        @keyframes modalBlurIn {
          from { backdrop-filter: blur(0px); background-color: rgba(0,0,0,0); }
          to { backdrop-filter: blur(8px); background-color: rgba(0,0,0,0.5); }
        }
        @keyframes modalSlideIn {
          from { transform: translateY(50px) scale(0.95); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes progressFill {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }
        @keyframes screenSlideIn {
          from { opacity: 0; transform: translateX(30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes screenSlideOut {
          from { opacity: 1; transform: translateX(0); }
          to { opacity: 0; transform: translateX(-30px); }
        }
        @keyframes pullRefresh {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes swipeHint {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(-10px); }
        }
        @keyframes levelUp {
          0% { transform: scale(1); }
          25% { transform: scale(1.2); }
          50% { transform: scale(1); }
          75% { transform: scale(1.1); }
          100% { transform: scale(1); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        .card-animate {
          animation: cardSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        .card-animate-1 { animation-delay: 0.05s; opacity: 0; }
        .card-animate-2 { animation-delay: 0.1s; opacity: 0; }
        .card-animate-3 { animation-delay: 0.15s; opacity: 0; }
        .card-animate-4 { animation-delay: 0.2s; opacity: 0; }
        .card-animate-5 { animation-delay: 0.25s; opacity: 0; }
        .screen-enter {
          animation: screenSlideIn 0.3s ease-out forwards;
        }
        .tab-bounce {
          animation: tabBounce 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .reaction-pop {
          animation: reactionPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .toast-animate {
          animation: toastSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .modal-backdrop {
          animation: modalBlurIn 0.3s ease-out forwards;
        }
        .modal-content {
          animation: modalSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .btn-press:active {
          animation: buttonPress 0.2s ease-out;
        }
        .progress-animate {
          animation: progressFill 1s ease-out forwards;
          transform-origin: left;
        }
        * {
          box-sizing: border-box;
          -webkit-tap-highlight-color: transparent;
        }
        body {
          margin: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        input:focus, textarea:focus {
          border-color: #0d2847 !important;
          box-shadow: 0 0 0 3px rgba(13,40,71,0.1) !important;
        }
        button {
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, background-color 0.2s ease, opacity 0.2s ease;
        }
        button:active {
          transform: scale(0.94);
        }
        button:hover {
          transform: scale(1.03);
        }
        /* Premium loading shimmer */
        @keyframes loadingShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .loading-shimmer {
          background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
          background-size: 200% 100%;
          animation: loadingShimmer 1.5s ease-in-out infinite;
        }
        /* Smooth hover lift effect */
        .hover-lift {
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease;
        }
        .hover-lift:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 30px rgba(0,0,0,0.15);
        }
        /* Card entrance stagger */
        @keyframes cardEntrance {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .card-entrance {
          animation: cardEntrance 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Button press ripple */
        @keyframes buttonRipple {
          0% { transform: scale(0); opacity: 0.6; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        /* Glow pulse for active states */
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 5px rgba(13,40,71,0.2); }
          50% { box-shadow: 0 0 20px rgba(13,40,71,0.4); }
        }
        /* Smooth icon rotation */
        @keyframes iconSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .icon-spin {
          animation: iconSpin 1s linear infinite;
        }
        /* Success checkmark animation */
        @keyframes successCheck {
          0% { transform: scale(0) rotate(-45deg); opacity: 0; }
          50% { transform: scale(1.2) rotate(0deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        .success-check {
          animation: successCheck 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Slide in from bottom */
        @keyframes slideInBottom {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .slide-in-bottom {
          animation: slideInBottom 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Scale bounce in */
        @keyframes scaleBounceIn {
          0% { transform: scale(0); }
          60% { transform: scale(1.1); }
          100% { transform: scale(1); }
        }
        .scale-bounce-in {
          animation: scaleBounceIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        /* Subtle breathing animation */
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
        .breathe {
          animation: breathe 3s ease-in-out infinite;
        }
        /* Enhanced focus states */
        input:focus, textarea:focus, select:focus {
          outline: none;
          border-color: #0d2847 !important;
          box-shadow: 0 0 0 4px rgba(13,40,71,0.1), 0 2px 8px rgba(13,40,71,0.1) !important;
          transition: all 0.2s ease;
        }
        /* Smooth scroll behavior */
        * {
          scroll-behavior: smooth;
        }
        /* Link hover underline animation */
        .link-hover {
          position: relative;
        }
        .link-hover::after {
          content: '';
          position: absolute;
          bottom: -2px;
          left: 0;
          width: 0;
          height: 2px;
          background: #0d2847;
          transition: width 0.3s ease;
        }
        .link-hover:hover::after {
          width: 100%;
        }
        /* Gradient text animation */
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .gradient-text {
          background: linear-gradient(135deg, #0d2847, #2d5a87, #14B8A6, #0d2847);
          background-size: 300% 300%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: gradientShift 4s ease infinite;
        }
        /* Notification badge bounce */
        @keyframes badgeBounce {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
        .badge-bounce {
          animation: badgeBounce 0.6s ease-in-out;
        }
        /* Skeleton loading for cards */
        .skeleton {
          background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 37%, #f0f0f0 63%);
          background-size: 400% 100%;
          animation: loadingShimmer 1.4s ease infinite;
          border-radius: 8px;
        }
        /* Premium glass effect */
        .glass {
          background: rgba(255,255,255,0.85);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.5);
        }
        /* Interactive card hover */
        .interactive-card {
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .interactive-card:hover {
          transform: translateY(-2px) scale(1.01);
          box-shadow: 0 8px 25px rgba(0,0,0,0.1);
        }
        .interactive-card:active {
          transform: translateY(0) scale(0.99);
        }
        ::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(13,40,71,0.15);
          border-radius: 4px;
          transition: background 0.2s ease;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(13,40,71,0.3);
        }
        /* Smooth scroll containers */
        [style*="overflow"] {
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
        }
        /* Loading indicator */
        @keyframes loadingPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .loading-pulse {
          animation: loadingPulse 1.5s ease-in-out infinite;
        }
        /* Highlight flash for new items */
        @keyframes highlightFlash {
          0% { background-color: rgba(20,184,166,0.2); }
          100% { background-color: transparent; }
        }
        .highlight-flash {
          animation: highlightFlash 1s ease-out;
        }
        /* Subtle scale on press */
        .press-scale:active {
          transform: scale(0.97);
        }
        /* Gradient border effect */
        .gradient-border {
          position: relative;
          background: white;
        }
        .gradient-border::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 2px;
          background: linear-gradient(135deg, #0d2847, #2d5a87);
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
        }
      `}</style>
    </div>
  );
};

const FlockApp = () => {
  const [authUser, setAuthUser] = useState(null);
  const [authScreen, setAuthScreen] = useState('login');
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      setAuthChecking(false);
      return;
    }
    getCurrentUser()
      .then((data) => setAuthUser(data.user || data))
      .catch(() => {
        logout();
        setAuthUser(null);
      })
      .finally(() => setAuthChecking(false));
  }, []);

  if (authChecking) {
    return (
      <div style={{
        minHeight: '100vh',
        background: `linear-gradient(135deg, #0d2847 0%, #1a3a5c 50%, #2d5a87 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}>
        <div style={{ textAlign: 'center', color: 'white' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🐦</div>
          <div style={{ fontSize: '18px', fontWeight: '600' }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!authUser) {
    if (authScreen === 'signup') {
      return (
        <SignupScreen
          onSignupSuccess={(user) => setAuthUser(user)}
          onSwitchToLogin={() => setAuthScreen('login')}
        />
      );
    }
    return (
      <LoginScreen
        onLoginSuccess={(user) => setAuthUser(user)}
        onSwitchToSignup={() => setAuthScreen('signup')}
      />
    );
  }

  return <FlockAppInner />;
};

export default FlockApp;
