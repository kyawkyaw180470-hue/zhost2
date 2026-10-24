export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const update = await request.json();
        
        if (update.callback_query) {
          await handleCallback(update.callback_query, env);
          return new Response("OK");
        }

        if (update.message && update.message.text) {
          await handleMessage(update.message, env);
          return new Response("OK");
        }

        return new Response("OK");
      } catch (e) {
        console.error(e);
        return new Response("Error: " + e.message, { status: 500 });
      }
    }
    return new Response("TWG Premium Bot is running!", { status: 200 });
  }
};

// ═══════════════════════════════════════════════
//  အချက်အလက်များ (Channel နှစ်ခု သတ်မှတ်ထားသည်)
// ═══════════════════════════════════════════════
const CHANNELS = ["@ZhostTech", "@twgmyidchannel"]; // 👈 Channel နှစ်ခု
const BOT_USERNAME = "twgtiktok_bot"; 
const ADMIN_ID = "8917413248"; 

// ═══════════════════════════════════════════════
//  Helper Functions
// ═══════════════════════════════════════════════
async function apiCall(token, method, payload) {
  if ((method === "sendMessage" || method === "editMessageText") && !payload.parse_mode) {
    payload.parse_mode = "HTML";
  }
  
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  return res.json();
}

async function deleteMessage(token, chatId, messageId) {
  if (!messageId || messageId === 0) return;
  try {
    await apiCall(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (e) {}
}

async function sendCleanMessage(token, chatId, user, text, replyMarkup = null) {
  if (user && user.last_msg_id) {
    await deleteMessage(token, chatId, user.last_msg_id);
  }
  const payload = { chat_id: chatId, text: text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return await apiCall(token, "sendMessage", payload);
}

async function updateLastMsgId(env, chatId, messageId) {
  await env.DB.prepare("UPDATE users SET last_msg_id = ? WHERE user_id = ?").bind(messageId, chatId).run();
}

// 🎯 Channel နှစ်ခုလုံး Join မှ True ပြန်မယ်
async function checkJoin(token, userId) {
  try {
    for (const channel of CHANNELS) {
      const data = await apiCall(token, "getChatMember", { chat_id: channel, user_id: userId });
      if (!data.ok) return false;
      
      const status = data.result.status;
      if (status !== "member" && status !== "administrator" && status !== "creator") {
        return false; // တစ်ခုခု မ Join ထားရင် false ပြန်မယ်
      }
    }
    return true; // နှစ်ခုလုံး Join ထားရင် true ပြန်မယ်
  } catch (e) {
    return false;
  }
}

// ═══════════════════════════════════════════════
//  Message Handler
// ═══════════════════════════════════════════════
async function handleMessage(message, env) {
  const chatId = message.chat.id.toString();
  const text = message.text.trim();
  const username = message.from.username || message.from.first_name || "သူငယ်ချင်း";

  await deleteMessage(env.BOT_TOKEN, chatId, message.message_id);

  let user = await env.DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(chatId).first();
  const isNewUser = !user;

  if (isNewUser) {
    let referredBy = null;
    if (text.startsWith("/start ref_")) referredBy = text.replace("/start ref_", "");
    await env.DB.prepare("INSERT INTO users (user_id, username, coins, referred_by, refer_rewarded, pending_action, last_msg_id) VALUES (?, ?, 0, ?, 0, NULL, 0)").bind(chatId, username, referredBy).run();
    user = { user_id: chatId, coins: 0, referred_by: referredBy, refer_rewarded: 0, pending_action: null, last_msg_id: 0 };
  }

  const joined = await checkJoin(env.BOT_TOKEN, chatId);
  if (!joined) {
    // 🎯 Channel နှစ်ခုလုံးအတွက် ခလုတ်နှစ်ခု ပြမယ်
    const keyboard = { 
      inline_keyboard: [
        [{ text: "📢 Join ZHOST Tech", url: "https://t.me/ZhostTech" }],
        [{ text: "📢 Join TWG Channel", url: "https://t.me/twgmyidchannel" }],
        [{ text: "✅ Join ပြီးပါပြီ", callback_data: "check_join" }]
      ] 
    };
    const res = await apiCall(env.BOT_TOKEN, "sendMessage", { 
      chat_id: chatId, 
      text: `ဟေး ${username} ရေ... 👋\nBot ကို စတင်အသုံးပြုဖို့အတွက် အောက်ပါ <b>Channel (၂) ခု</b> လုံးကို Join ပေးပါဦးနော်။`, 
      reply_markup: keyboard 
    });
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  const bottomMenu = {
    keyboard: [
      [{ text: "🚀 Boost လုပ်မယ်" }],
      [{ text: "👤 acc info" }, { text: "🎁 Daily Reward" }],
      [{ text: "💎 VIP ဝင်မယ်" }, { text: "👥 သူငယ်ချင်းဖိတ်ခေါ်မည်" }]
    ], resize_keyboard: true
  };

  if (text.startsWith("http")) {
    const isTikTok = /^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i.test(text);
    
    if (!isTikTok) {
      const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, "⚠️ စိတ်မကောင်းပါဘူး။ TikTok လင့်ခ် (tiktok.com) တွေကိုပဲ လက်ခံပါတယ်နော်။", bottomMenu);
      await updateLastMsgId(env, chatId, res.result.message_id);
      return;
    }

    if (user.pending_action === "views" || user.pending_action === "likes") {
      await processBoost(chatId, username, text, user, env, user.pending_action);
    } else {
      const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, "⚠️ ကျေးဇူးပြုပြီး အောက်ခြေက <b>🚀 Boost လုပ်မယ်</b> ခလုတ်ကနေ အရင်ရွေးပေးပါဦး။", bottomMenu);
      await updateLastMsgId(env, chatId, res.result.message_id);
    }
    return;
  }

  if (text === "/start" || text === "🏠 ပင်မစာမျက်နှာ") {
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `မင်္ဂလာပါ ${username} ရေ... 🙌\nZHOST & TWG မှ ကြိုဆိုပါတယ်နော်။\nအောက်က Menu လေးတွေကနေ စိတ်ကြိုက် ရွေးချယ်အသုံးပြုလို့ရပါပြီ။`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  if (text === "🚀 Boost လုပ်မယ်") {
    const inlineMenu = { inline_keyboard: [[{ text: "👁️ View Boost (1 Coin)", callback_data: "boost_view" }], [{ text: "❤️ Like Boost (1 Coin)", callback_data: "boost_like" }]] };
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `🚀 <b>ဘယ်ဟာကို Boost လုပ်ချင်တာလဲ ရွေးလိုက်ပါဦး?</b>`, inlineMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  if (text === "👤 acc info") {
    const refCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE referred_by = ? AND refer_rewarded = 1").bind(chatId).first();
    const infoText = `👤 <b>Account Info</b>\n\n📛 အမည်: ${username}\n🆔 ID: <code>${chatId}</code>\n💰 လက်ကျန် Coins: <b>${user.coins} Coins</b>\n👥 ကိုယ့်ကနေ ဖိတ်ခေါ်ပြီး Join သွားသူ: <b>${refCount.count} ယောက်</b>`;
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, infoText, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  if (text === "🎁 Daily Reward") {
    const now = Math.floor(Date.now() / 1000);
    if (now - user.last_daily < 86400) {
      const hoursLeft = Math.ceil((86400 - (now - user.last_daily)) / 3600);
      const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `⏳ ဒီနေ့အတွက် ယူပြီးသားဖြစ်နေတယ်နော်။ နောက် <b>${hoursLeft} နာရီ</b> လောက်နေမှ ပြန်ယူလို့ရပါမယ်။`, bottomMenu);
      await updateLastMsgId(env, chatId, res.result.message_id);
    } else {
      await env.DB.prepare("UPDATE users SET coins = coins + 2, last_daily = ? WHERE user_id = ?").bind(now, chatId).run();
      const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `🎁 အားပေးတဲ့အတွက် ကျေးဇူးတင်ပါတယ်။ <b>2 Coins</b> ရသွားပါပြီနော်!`, bottomMenu);
      await updateLastMsgId(env, chatId, res.result.message_id);
    }
    return;
  }

  if (text === "💎 VIP ဝင်မယ်") {
    const vipText = `💎 <b>ZHOST VIP Package</b>\n\n💰 စျေးနှုန်း: 2000ks\n🎁 ရရှိမည့် အကျိုးခံစားခွင့်: 500 Coins\n\nVIP ဝင်လိုပါက Admin ဆီကို ဆက်သွယ်ပေးပါ။\n\n<i>(သင့်တောင်းဆိုမှုကို Admin ဆီသို့ အသိပေးပို့ထားပါသည်။)</i>`;
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, vipText, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);

    await apiCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: ADMIN_ID,
      text: `🔔 <b>VIP တောင်းဆိုမှု အသစ်!</b>\n\n👤 အမည်: ${username}\n🆔 ID: <code>${chatId}</code>\n\nဒီ User ကို VIP ပေးမလား?`,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ VIP Confirm (+500 Coins)", callback_data: `admin_vip_confirm_${chatId}` }]]
      }
    });
    return;
  }

  if (text === "👥 သူငယ်ချင်းဖိတ်ခေါ်မည်") {
    const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
    const refText = `👥 <b>သူငယ်ချင်း ဖိတ်ခေါ်ခြင်း</b>\n\nသူငယ်ချင်းတွေကို ဒီ Link လေး Share ပေးလိုက်ပါ။\nသူတို့ <b>Channel Join လုပ်တာနဲ့</b> သင့်ဆီကို <b>4 Coins</b> ရောက်လာပါလိမ့်မယ်။\n\n<code>${refLink}</code>`;
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, refText, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `😅 နားမလည်လိုက်ဘူးနော်။ အောက်က Menu လေးတွေကို နှိပ်ကြည့်ပါဦး။`, bottomMenu);
  await updateLastMsgId(env, chatId, res.result.message_id);
}

// ═══════════════════════════════════════════════
//  Callback Query Handler
// ═══════════════════════════════════════════════
async function handleCallback(query, env) {
  const chatId = query.message.chat.id.toString();
  const messageId = query.message.message_id;
  const data = query.data;
  const username = query.from.username || query.from.first_name || "သူငယ်ချင်း";

  await apiCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
  let user = await env.DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(chatId).first();

  const bottomMenu = {
    keyboard: [
      [{ text: "🚀 Boost လုပ်မယ်" }],
      [{ text: "👤 acc info" }, { text: "🎁 Daily Reward" }],
      [{ text: "💎 VIP ဝင်မယ်" }, { text: "👥 သူငယ်ချင်းဖိတ်ခေါ်မည်" }]
    ], resize_keyboard: true
  };

  if (data.startsWith("admin_vip_confirm_")) {
    if (chatId !== ADMIN_ID) {
      await apiCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "⛔ Admin ပဲ နှိပ်လို့ရပါတယ်။", show_alert: true });
      return;
    }

    const targetUserId = data.replace("admin_vip_confirm_", "");
    await env.DB.prepare("UPDATE users SET coins = coins + 500 WHERE user_id = ?").bind(targetUserId).run();

    await apiCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: targetUserId,
      text: "🎉 <b>ဂုဏ်ယူပါတယ်! သင်ဟာ ZHOST VIP ဖြစ်သွားပါပြီ။</b>\n\n💰 သင့်အကောင့်ထဲကို <b>500 Coins</b> ထည့်သွင်းပြီးပါပြီ။"
    });

    await apiCall(env.BOT_TOKEN, "editMessageText", {
      chat_id: ADMIN_ID,
      message_id: messageId,
      text: `✅ <b>VIP Confirm လုပ်ပြီးပါပြီ။</b>\nUser ID: <code>${targetUserId}</code> ဆီကို 500 Coins ထည့်ပေးလိုက်ပါပြီ။`
    });
    return;
  }

  if (data === "check_join") {
    const joined = await checkJoin(env.BOT_TOKEN, chatId);
    if (joined) {
      if (user.referred_by && user.refer_rewarded === 0) {
        await env.DB.prepare("UPDATE users SET coins = coins + 4 WHERE user_id = ?").bind(user.referred_by).run();
        await env.DB.prepare("UPDATE users SET refer_rewarded = 1 WHERE user_id = ?").bind(chatId).run();
        await apiCall(env.BOT_TOKEN, "sendMessage", { chat_id: user.referred_by, text: `🎉 သင့် Link ကနေ သူငယ်ချင်းတစ်ယောက် Join လုပ်သွားလို့ <b>4 Coins</b> ရောက်လာပါပြီ!` });
      }
      await deleteMessage(env.BOT_TOKEN, chatId, messageId);
      const res = await apiCall(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `ကျေးဇူးတင်ပါတယ်နော် ${username} ရေ! 🎉\nအောက်က Menu လေးတွေကနေ စတင်အသုံးပြုလို့ရပါပြီ။`, reply_markup: bottomMenu });
      await updateLastMsgId(env, chatId, res.result.message_id);
    } else {
      await apiCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "😅 Channel နှစ်ခုလုံးကို Join ထားဖို့ လိုပါတယ်နော်။", show_alert: true });
    }
    return;
  }

  if (data === "boost_view" || data === "boost_like") {
    const type = data === "boost_view" ? "views" : "likes";
    await env.DB.prepare("UPDATE users SET pending_action = ? WHERE user_id = ?").bind(type, chatId).run();
    await deleteMessage(env.BOT_TOKEN, chatId, messageId);
    
    const typeName = type === "views" ? "👁️ View" : "❤️ Like";
    const res = await apiCall(env.BOT_TOKEN, "sendMessage", { 
      chat_id: chatId, 
      text: `🚀 <b>${typeName} Boost အသင့်ဖြစ်ပါပြီ။</b>\n\nကျေးဇူးပြုပြီး သင့် TikTok ဗီဒီယိုရဲ့ Link ကို ဒီ Chat ထဲမှာ ပို့ပေးလိုက်ပါ။\n(ဥပမာ - <code>https://vm.tiktok.com/...</code>)\n\n⚠️ <i>Boost ၁ ခါ လုပ်တိုင်း 1 Coin ကုန်ပါမယ်။</i>`, 
      reply_markup: bottomMenu 
    });
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }
}

// ═══════════════════════════════════════════════
//  Boost Logic
// ═══════════════════════════════════════════════
async function processBoost(chatId, username, tiktokUrl, user, env, type) {
  const now = Math.floor(Date.now() / 1000);
  const bottomMenu = {
    keyboard: [
      [{ text: "🚀 Boost လုပ်မယ်" }],
      [{ text: "👤 acc info" }, { text: "🎁 Daily Reward" }],
      [{ text: "💎 VIP ဝင်မယ်" }, { text: "👥 သူငယ်ချင်းဖိတ်ခေါ်မည်" }]
    ], resize_keyboard: true
  };

  if (user.coins < 1) {
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `😅 သူငယ်ချင်းရေ... မင်းဆီမှာ Coin မရှိတော့ဘူးနော်။\nDaily Reward သွားယူပြီး ပြန်လာခဲ့ပါဦး။`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  if (now - user.last_boost_time < 300) {
    const waitMins = Math.ceil((300 - (now - user.last_boost_time)) / 60);
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `⏳ ဟိုက်ကွင်း အရမ်းမြန်နေတယ်နော်။ နောက် <b>${waitMins} မိနစ်</b> လောက်နေမှ ထပ်လုပ်လို့ရပါမယ်။`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  const previousBoost = await env.DB.prepare("SELECT * FROM boosts WHERE user_id = ? AND link = ?").bind(chatId, tiktokUrl).first();
  if (previousBoost && (now - previousBoost.timestamp < 72000)) {
    const hoursLeft = Math.ceil((72000 - (now - previousBoost.timestamp)) / 3600);
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, user, `✋ ဒီ Link ကို Boost လုပ်ပြီးသားဖြစ်နေတယ်နော်။\nနောက် <b>${hoursLeft} နာရီ</b> လောက်နေမှ ပြန်ပြီး Boost လုပ်လို့ရပါမယ်။`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
    return;
  }

  const resMsg = await apiCall(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `⏳ ခဏလေးနော် ${username} ရေ... မင်းရဲ့ TikTok ကို Boost ပေးနေတယ်။` });
  await updateLastMsgId(env, chatId, resMsg.result.message_id);
  
  const result = await processLeofame(type, tiktokUrl);

  if (result.success) {
    await env.DB.prepare("UPDATE users SET coins = coins - 1, last_boost_time = ?, pending_action = NULL WHERE user_id = ?").bind(now, chatId).run();
    await env.DB.prepare("INSERT INTO boosts (user_id, link, timestamp) VALUES (?, ?, ?) ON CONFLICT(user_id, link) DO UPDATE SET timestamp = ?").bind(chatId, tiktokUrl, now, now).run();
    
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, {last_msg_id: resMsg.result.message_id}, `✅ <b>Boost အောင်မြင်ပါတယ်!</b>\n\n${result.message}\n\n💰 <i>1 Coin နှုတ်လိုက်ပါပြီ။</i>\nအားပေးတဲ့အတွက် ကျေးဇူးတင်ပါတယ်နော်။`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
  } else {
    await env.DB.prepare("UPDATE users SET pending_action = NULL WHERE user_id = ?").bind(chatId).run();
    const res = await sendCleanMessage(env.BOT_TOKEN, chatId, {last_msg_id: resMsg.result.message_id}, `❌ စိတ်မကောင်းပါဘူး သူငယ်ချင်းရာ... Boost မအောင်မြင်ဘူးဖြစ်နေတယ်။\n(အကြောင်းပြချက်: ${result.message})\n\n<i>Coin မနှုတ်ထားပါဘူးနော်။ ခဏနေမှ ပြန်စမ်းကြည့်ပါဦး။</i>`, bottomMenu);
    await updateLastMsgId(env, chatId, res.result.message_id);
  }
}

// ═══════════════════════════════════════════════
//  Leofame API
// ═══════════════════════════════════════════════
async function processLeofame(type, tiktokUrl) {
  const baseUrl = `https://leofame.com/free-tiktok-${type}`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": baseUrl,
    "Origin": "https://leofame.com"
  };
  
  try {
    const getRes = await fetch(baseUrl, { headers });
    const html = await getRes.text();
    const setCookie = getRes.headers.get("set-cookie");
    const tokenMatch = html.match(/name="token"\s+value="([^"]+)"/);
    
    if (!tokenMatch) throw new Error("Token ရှာမတွေ့ပါ။ (Cloudflare Block ဖြစ်နိုင်ပါသည်)");
    const token = tokenMatch[1];
    
    const formData = new URLSearchParams();
    formData.append("token", token);
    formData.append("timezone_offset", "Asia/Yangon");
    formData.append("timezone_offset_2", "1234");
    formData.append("free_link", tiktokUrl);

    const postHeaders = {
      ...headers,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json, text/javascript, */*; q=0.01"
    };
    
    if (setCookie) postHeaders["Cookie"] = setCookie;

    const postRes = await fetch(baseUrl + "?api=1", { method: "POST", headers: postHeaders, body: formData.toString() });
    const result = await postRes.text();
    
    try {
      const json = JSON.parse(result);
      if (json.success) return { success: true, message: json.success };
      if (json.error) return { success: false, message: json.error };
      if (result.trim() === "") return { success: true, message: "ဆာဗာမှ လက်ခံပြီးပါပြီ။" };
    } catch (e) {}
    
    return { success: false, message: "မသိသော တုံ့ပြန်မှု (Status: " + postRes.status + ")" };
  } catch (error) {
    return { success: false, message: error.message };
  }
}