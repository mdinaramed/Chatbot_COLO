require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const CHAT_URL = process.env.CHAT_URL || `http://localhost:${PORT}/chat`;

// gemini-1.5-flash сейчас недоступна для вашего ключа: Gemini возвращает 404.
// gemini-flash-latest проверена вашим ключом и возвращает 200.
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
].filter((model, index, models) => model && models.indexOf(model) === index);

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
}

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in .env");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userSessions = {};
const TELEGRAM_MESSAGE_LIMIT = 4000;
const APPOINTMENT_PRICE = "5000 ₸";
const APPOINTMENT_DAYS = [
  { label: "Пн", value: "Mon" },
  { label: "Вт", value: "Tue" },
  { label: "Ср", value: "Wed" },
  { label: "Чт", value: "Thu" },
  { label: "Пт", value: "Fri" },
];
const MORNING_TIMES = ["09:00", "10:00", "11:00", "12:00", "13:00"];
const EVENING_TIMES = ["15:00", "16:00", "17:00", "18:00"];
const APPOINTMENT_TIMES = [...MORNING_TIMES, ...EVENING_TIMES];

async function httpFetch(url, options) {
  if (typeof fetch === "function") {
    return fetch(url, options);
  }

  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch(url, options);
}

async function readJsonResponse(response) {
  const rawText = await response.text();

  if (!rawText) {
    return { rawText: "", json: null };
  }

  try {
    return { rawText, json: JSON.parse(rawText) };
  } catch (error) {
    console.log("[HTTP] JSON parse error:", error.message);
    return { rawText, json: null };
  }
}

function maskSecret(secret) {
  if (!secret || secret.length < 8) {
    return "***";
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

const yesNoKeyboard = {
  reply_markup: {
    keyboard: [["Да", "Нет"]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

const questions = [
  {
    key: "age",
    text: "Сколько вам лет?",
  },
  {
    key: "sex",
    text: "Ваш пол? (Мужской / Женский)",
    keyboard: [["Мужской", "Женский"]],
    allowedAnswers: ["Мужской", "Женский"],
  },
  {
    key: "heightWeight",
    text: "Ваш рост и вес?",
  },
  {
    key: "familyColonCancer",
    text: "Были ли у ваших близких родственников рак кишечника? (Да / Нет / Не знаю)",
    keyboard: [["Да", "Нет", "Не знаю"]],
    allowedAnswers: ["Да", "Нет", "Не знаю"],
  },
  {
    key: "familyColonCancerAge",
    text: "Если да — в каком возрасте?",
    shouldAsk: (answers) => answers.familyColonCancer === "Да",
  },
  {
    key: "intestinalPolyps",
    text: "Были ли у вас ранее полипы кишечника? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "previousColonoscopy",
    text: "Проходили ли вы колоноскопию раньше? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "previousColonoscopyDate",
    text: "Если да — когда?",
    shouldAsk: (answers) => answers.previousColonoscopy === "Да",
  },
  {
    key: "inflammatoryBowelDisease",
    text: "Были ли воспалительные заболевания кишечника? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "bloodInStool",
    text: "Есть ли кровь в стуле? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "stoolChanges",
    text: "Были ли изменения стула? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "abdominalPain",
    text: "Есть ли боли в животе? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "incompleteEvacuation",
    text: "Есть ли ощущение неполного опорожнения? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "weightLossOrWeakness",
    text: "Была ли потеря веса или слабость? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "smoking",
    text: "Курите ли вы? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "alcohol",
    text: "Употребляете ли алкоголь? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "sedentaryLifestyle",
    text: "Малоподвижный образ жизни? (Да / Нет)",
    yesNo: true,
  },
  {
    key: "chronicDiseases",
    text: "Хронические заболевания (текст)",
  },
];

function buildKeyboard(question) {
  if (question.yesNo) {
    return yesNoKeyboard;
  }

  if (question.keyboard) {
    return {
      reply_markup: {
        keyboard: question.keyboard,
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
  }

  return {
    reply_markup: {
      remove_keyboard: true,
    },
  };
}

function formatAnswersForPrompt(answers) {
  return questions
    .map((question, index) => {
      const answer = answers[question.key] || "Нет ответа";
      return `${index + 1}. ${question.text}\nОтвет: ${answer}`;
    })
    .join("\n\n");
}

function createGeminiPrompt(answers) {
  return `You are a medical assistant.
Analyze the patient data and provide:

1. Risk level (low / medium / high)
2. Key risk factors
3. Recommendations

Patient data:
${formatAnswersForPrompt(answers)}

Important:
- This is informational support only.
- Do not provide a final diagnosis.
- Recommend seeing a qualified doctor when symptoms or risk factors are present.
- Reply in Russian.
- Do not add introductory phrases like "На основании предоставленных данных".
- Start immediately with the analysis.
- Keep the answer very short, practical, and mobile-friendly.
- Use simple words, no long medical explanations.
- Maximum length: 700 characters.`;
}

function getQuestionBySession(session) {
  return questions[session.currentQuestionIndex];
}

function skipIrrelevantQuestions(session) {
  while (session.currentQuestionIndex < questions.length) {
    const question = getQuestionBySession(session);

    if (!question.shouldAsk || question.shouldAsk(session.answers)) {
      break;
    }

    session.answers[question.key] = "Не применимо";
    session.currentQuestionIndex += 1;
  }
}

async function askCurrentQuestion(chatId, session) {
  skipIrrelevantQuestions(session);

  if (session.currentQuestionIndex >= questions.length) {
    await completeQuestionnaire(chatId, session);
    return;
  }

  const question = getQuestionBySession(session);
  await bot.sendMessage(chatId, question.text, buildKeyboard(question));
}

function validateAnswer(question, answer) {
  const trimmedAnswer = answer.trim();

  if (!trimmedAnswer) {
    return "Пожалуйста, отправьте ответ текстом.";
  }

  if (question.yesNo && !["Да", "Нет"].includes(trimmedAnswer)) {
    return "Пожалуйста, выберите: Да или Нет.";
  }

  if (question.allowedAnswers && !question.allowedAnswers.includes(trimmedAnswer)) {
    return `Пожалуйста, выберите один из вариантов: ${question.allowedAnswers.join(" / ")}.`;
  }

  return null;
}

function getUserFriendlyError(error) {
  const message = error.message || "";

  if (message.includes("quota") || message.includes("429")) {
    return "Gemini API отвечает, но для этого API-ключа закончилась или не подключена квота генерации. Проверьте Billing / quota в Google AI Studio.";
  }

  if (message.includes("not found") || message.includes("404")) {
    return "Модель Gemini недоступна для этого API-ключа. Проверьте GEMINI_MODEL или используйте gemini-flash-latest.";
  }

  if (message.toLowerCase().includes("leaked")) {
    return "Gemini API-ключ был помечен Google как скомпрометированный. Создайте новый ключ в Google AI Studio, замените GEMINI_API_KEY в .env и перезапустите бота.";
  }

  if (message.includes("API key") || message.includes("403") || message.includes("401")) {
    return "API-ключ Gemini не принят. Проверьте GEMINI_API_KEY в .env.";
  }

  return "Не удалось выполнить анализ. Попробуйте позже или начните заново командой /start.";
}

function escapeMarkdown(text) {
  return String(text || "").replace(/([_*`\[])/g, "\\$1");
}

function cleanAIText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/^.*на основании предоставленн[^\n]*\n?/i, "")
    .replace(/^.*информация носит ознакомительн[^\n]*\n?/i, "")
    .replace(/^.*не является окончательным диагнозом[^\n]*\n?/i, "")
    .trim();
}

function removeSectionHeading(text) {
  return String(text || "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*\d+[\).]\s*/gm, "")
    .replace(/^\s*(уровень риска|risk level|факторы риска|ключевые факторы риска|ключевые факторы|тревожные признаки|recommendations|рекомендации)\s*:?\s*/gim, "")
    .replace(/^-{3,}$/gm, "")
    .trim();
}

function extractSection(text, startPatterns, endPatterns = []) {
  const source = cleanAIText(text);
  const lowerSource = source.toLowerCase();

  const startIndexes = startPatterns
    .map((pattern) => lowerSource.search(pattern))
    .filter((index) => index >= 0);

  if (!startIndexes.length) {
    return "";
  }

  const startIndex = Math.min(...startIndexes);
  let endIndex = source.length;
  const afterStart = lowerSource.slice(startIndex + 1);

  for (const pattern of endPatterns) {
    const relativeEnd = afterStart.search(pattern);

    if (relativeEnd >= 0) {
      endIndex = Math.min(endIndex, startIndex + 1 + relativeEnd);
    }
  }

  return removeSectionHeading(source.slice(startIndex, endIndex));
}

function extractRiskLevel(text) {
  const riskSection = extractSection(
    text,
    [/уровень\s+риска/i, /risk\s+level/i],
    [/факторы\s+риска/i, /ключевые\s+факторы/i, /тревожные\s+признаки/i, /рекомендации/i]
  );

  const source = riskSection || cleanAIText(text);
  const riskMatch = source.match(/(низкий|средний|высокий|low|medium|high)/i);

  if (!riskMatch) {
    return riskSection.split("\n").find(Boolean) || "Не указан";
  }

  const normalizedRisk = riskMatch[1].toLowerCase();
  const labels = {
    low: "Низкий",
    medium: "Средний",
    high: "Высокий",
    низкий: "Низкий",
    средний: "Средний",
    высокий: "Высокий",
  };

  return labels[normalizedRisk] || riskMatch[1];
}

function truncateText(text, maxLength = 72) {
  const value = String(text || "").trim();

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function textToBulletList(text, fallbackText, maxItems = 2) {
  const source = removeSectionHeading(text || fallbackText || "");

  if (!source) {
    return "• Не указано";
  }

  const lines = source
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[-*•]\s*/, "")
        .replace(/^\s*\d+[\).]\s*/, "")
        .trim()
    )
    .filter(Boolean)
    .filter((line) => !/^важно:?$/i.test(line));

  const items = lines.length
    ? lines
    : source
        .split(/(?<=[.!?])\s+/)
        .map((line) => line.trim())
        .filter(Boolean);

  return items
    .map((item) => item.replace(/^[:\-\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => `• ${escapeMarkdown(truncateText(item))}`)
    .join("\n");
}

function formatAIResponse(text) {
  const cleanedText = cleanAIText(text);
  const riskLevel = extractRiskLevel(cleanedText);
  const riskFactors = extractSection(
    cleanedText,
    [/факторы\s+риска/i, /ключевые\s+факторы/i, /тревожные\s+признаки/i, /risk\s+factors/i],
    [/рекомендации/i, /recommendations/i]
  );
  const recommendations = extractSection(
    cleanedText,
    [/рекомендации/i, /recommendations/i],
    []
  );
  const factorList = textToBulletList(riskFactors, cleanedText, 2);
  const recommendationList = textToBulletList(
    recommendations,
    "Обратиться к врачу\nСледить за симптомами",
    2
  );

  return [
    "🧠 *Результат*",
    `📊 Риск: *${escapeMarkdown(riskLevel)}*`,
    "⚠️ *Главное:*",
    factorList,
    "💡 *Что делать:*",
    recommendationList,
  ].join("\n");
}

function splitMessage(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remainingText = text;

  while (remainingText.length > maxLength) {
    let splitIndex = remainingText.lastIndexOf("\n\n", maxLength);

    if (splitIndex < maxLength * 0.5) {
      splitIndex = remainingText.lastIndexOf("\n", maxLength);
    }

    if (splitIndex < maxLength * 0.5) {
      splitIndex = remainingText.lastIndexOf(". ", maxLength);
    }

    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remainingText.slice(0, splitIndex).trim());
    remainingText = remainingText.slice(splitIndex).trim();
  }

  if (remainingText) {
    chunks.push(remainingText);
  }

  return chunks;
}

async function sendLongMessage(chatId, text, options = {}) {
  const chunks = splitMessage(text);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    const messageOptions = isLastChunk
      ? options
      : {
          ...options,
          reply_markup: undefined,
        };

    await bot.sendMessage(chatId, chunks[index], messageOptions);
  }
}

function buildAppointmentStartKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Записаться к врачу", callback_data: "appointment_start" }],
    ],
  };
}

function buildAppointmentDayKeyboard() {
  return {
    inline_keyboard: [
      APPOINTMENT_DAYS.map((day) => ({
        text: day.label,
        callback_data: `day_${day.value}`,
      })),
    ],
  };
}

function buildAppointmentTimeKeyboard() {
  return {
    inline_keyboard: [
      MORNING_TIMES.map((time) => ({
        text: time,
        callback_data: `time_${time}`,
      })),
      [{ text: "Перерыв", callback_data: "noop" }],
      EVENING_TIMES.map((time) => ({
        text: time,
        callback_data: `time_${time}`,
      })),
    ],
  };
}

function buildAppointmentConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Подтвердить", callback_data: "confirm_appointment" },
        { text: "Отмена", callback_data: "cancel_appointment" },
      ],
    ],
  };
}

async function showAppointmentDays(chatId) {
  userSessions[chatId] = {
    step: "day",
    day: null,
    time: null,
    name: null,
    phone: null,
  };

  await bot.sendMessage(chatId, "📅 Выберите день:", {
    reply_markup: buildAppointmentDayKeyboard(),
  });
}

async function showAppointmentTimes(chatId, day) {
  userSessions[chatId] = {
    step: "time",
    day,
    time: null,
    name: null,
    phone: null,
  };

  await bot.sendMessage(chatId, "⏰ Выберите время:", {
    reply_markup: buildAppointmentTimeKeyboard(),
  });
}

async function askAppointmentName(chatId, time) {
  const session = userSessions[chatId];

  if (!session?.day) {
    await showAppointmentDays(chatId);
    return;
  }

  userSessions[chatId] = {
    ...session,
    step: "name",
    time,
  };

  await bot.sendMessage(chatId, "Введите ваше ФИО:");
}

async function showAppointmentConfirm(chatId) {
  const session = userSessions[chatId];

  if (!session?.day || !session?.time || !session?.name || !session?.phone) {
    await showAppointmentDays(chatId);
    return;
  }

  userSessions[chatId] = {
    ...session,
    step: "confirm",
  };

  await bot.sendMessage(
    chatId,
    [
      "Проверьте запись:",
      "",
      `📅 ${escapeMarkdown(session.day)}`,
      `⏰ ${escapeMarkdown(session.time)}`,
      `👤 ${escapeMarkdown(session.name)}`,
      `📞 ${escapeMarkdown(session.phone)}`,
      "",
      `Стоимость: *${escapeMarkdown(APPOINTMENT_PRICE)}*`,
    ].join("\n"),
    {
      parse_mode: "Markdown",
      reply_markup: buildAppointmentConfirmKeyboard(),
    }
  );
}

function getAppointmentDayLabel(value) {
  return APPOINTMENT_DAYS.find((day) => day.value === value)?.label || null;
}

function isAppointmentSession(session) {
  return ["day", "time", "name", "phone", "confirm"].includes(session?.step);
}

async function handleAppointmentMessage(chatId, text, session) {
  const value = text.trim();

  if (session.step === "name") {
    if (value.length < 3) {
      await bot.sendMessage(chatId, "Введите полное ФИО, пожалуйста.");
      return;
    }

    userSessions[chatId] = {
      ...session,
      step: "phone",
      name: value,
    };

    await bot.sendMessage(chatId, "Введите номер телефона:");
    return;
  }

  if (session.step === "phone") {
    if (value.replace(/\D/g, "").length < 10) {
      await bot.sendMessage(chatId, "Введите корректный номер телефона.");
      return;
    }

    userSessions[chatId] = {
      ...session,
      step: "confirm",
      phone: value,
    };

    await showAppointmentConfirm(chatId);
    return;
  }

  if (session.step === "day") {
    await bot.sendMessage(chatId, "Выберите день кнопкой ниже:", {
      reply_markup: buildAppointmentDayKeyboard(),
    });
    return;
  }

  if (session.step === "time") {
    await bot.sendMessage(chatId, "Выберите время кнопкой ниже:", {
      reply_markup: buildAppointmentTimeKeyboard(),
    });
    return;
  }

  await bot.sendMessage(chatId, "Подтвердите или отмените запись кнопкой ниже:", {
    reply_markup: buildAppointmentConfirmKeyboard(),
  });
}

async function completeQuestionnaire(chatId, session) {
  await bot.sendMessage(chatId, "Спасибо. Анализирую данные...", {
    reply_markup: { remove_keyboard: true },
  });

  try {
    console.log(`[BOT] Starting analysis for chatId=${chatId}`);
    console.log(
      `[BOT] Collected answers for chatId=${chatId}:`,
      JSON.stringify(session.answers, null, 2)
    );

    const response = await httpFetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answers: session.answers }),
    });

    const { rawText, json } = await readJsonResponse(response);

    console.log(`[BOT] /chat status=${response.status}`);
    console.log("[BOT] /chat response:", json || rawText);

    if (!response.ok) {
      const errorMessage =
        json?.error || rawText || `Analysis endpoint failed with ${response.status}`;
      throw new Error(errorMessage);
    }

    if (!json?.result) {
      throw new Error("Analysis endpoint returned an empty result");
    }

    await sendLongMessage(chatId, formatAIResponse(json.result), {
      parse_mode: "Markdown",
      reply_markup: buildAppointmentStartKeyboard(),
    });
  } catch (error) {
    console.log(`[BOT] Analysis error for chatId=${chatId}:`, error);
    await bot.sendMessage(chatId, getUserFriendlyError(error), {
      reply_markup: { remove_keyboard: true },
    });
  } finally {
    delete userSessions[chatId];
    console.log(`[BOT] Session reset for chatId=${chatId}`);
  }
}

async function callGeminiModel(model, answers) {
  const prompt = createGeminiPrompt(answers);
  const requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 800,
    },
  };

  console.log(`[GEMINI] Calling model=${model}`);
  console.log(`[GEMINI] API key=${maskSecret(GEMINI_API_KEY)}`);
  console.log(`[GEMINI] Prompt length=${prompt.length}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await httpFetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const { rawText, json } = await readJsonResponse(response);

    console.log(`[GEMINI] model=${model} status=${response.status}`);

    if (!response.ok) {
      console.log("[GEMINI] Error response:", json || rawText);
      const message =
        json?.error?.message ||
        rawText ||
        `Gemini API request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const result = json?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join("\n")
      .trim();

    const finishReason = json?.candidates?.[0]?.finishReason;

    if (!result) {
      console.log("[GEMINI] Empty result. Full response:", json || rawText);
      throw new Error(`Gemini API returned an empty result. Finish reason: ${finishReason}`);
    }

    console.log(`[GEMINI] Success with model=${model}`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(answers) {
  let lastError;

  for (const model of GEMINI_MODELS) {
    try {
      return await callGeminiModel(model, answers);
    } catch (error) {
      lastError = error;
      console.log(`[GEMINI] Model failed=${model}:`, error.message);

      if (error.status === 401 || error.status === 403 || error.status === 429) {
        break;
      }
    }
  }

  throw lastError || new Error("Gemini API request failed");
}

app.post("/chat", async (req, res) => {
  const answers = req.body?.answers || req.body;

  console.log("[/chat] Incoming request");

  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    console.log("[/chat] Invalid answers payload:", req.body);
    return res.status(400).json({ error: "answers must be a JSON object" });
  }

  try {
    const result = await callGemini(answers);
    return res.json({ result });
  } catch (error) {
    console.log("[/chat] Gemini request failed:", error);
    return res.status(502).json({
      error: error.message || "Failed to analyze patient data",
    });
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  console.log(`[BOT] /start from chatId=${chatId}`);

  userSessions[chatId] = {
    currentQuestionIndex: 0,
    answers: {},
  };

  await bot.sendMessage(
    chatId,
    "Здравствуйте. Я задам несколько вопросов для сбора анамнеза. Отвечайте по порядку.",
    { reply_markup: { remove_keyboard: true } }
  );

  await askCurrentQuestion(chatId, userSessions[chatId]);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/start")) {
    return;
  }

  const session = userSessions[chatId];

  if (!session) {
    await bot.sendMessage(chatId, "Чтобы начать анкету, отправьте /start.");
    return;
  }

  if (isAppointmentSession(session)) {
    await handleAppointmentMessage(chatId, text, session);
    return;
  }

  skipIrrelevantQuestions(session);

  const question = getQuestionBySession(session);

  if (!question) {
    await completeQuestionnaire(chatId, session);
    return;
  }

  const validationError = validateAnswer(question, text);

  if (validationError) {
    await bot.sendMessage(chatId, validationError, buildKeyboard(question));
    return;
  }

  session.answers[question.key] = text.trim();
  session.currentQuestionIndex += 1;

  console.log(
    `[BOT] Answer saved chatId=${chatId}, question=${question.key}, index=${session.currentQuestionIndex}/${questions.length}`
  );

  await askCurrentQuestion(chatId, session);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  if (!chatId) {
    return;
  }

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === "noop") {
      return;
    }

    if (data === "appointment_start") {
      console.log(`[APPOINTMENT] Start chatId=${chatId}`);
      await showAppointmentDays(chatId);
      return;
    }

    if (data.startsWith("day_")) {
      const dayValue = data.slice("day_".length);
      const dayLabel = getAppointmentDayLabel(dayValue);

      if (!dayLabel) {
        await bot.sendMessage(chatId, "Выберите день из списка.");
        return;
      }

      console.log(`[APPOINTMENT] Day selected chatId=${chatId}, day=${dayLabel}`);
      await showAppointmentTimes(chatId, dayLabel);
      return;
    }

    if (data.startsWith("time_")) {
      const time = data.slice("time_".length);

      if (!APPOINTMENT_TIMES.includes(time)) {
        await bot.sendMessage(chatId, "Выберите время из списка.");
        return;
      }

      const session = userSessions[chatId];

      if (!isAppointmentSession(session) || !session.day) {
        await showAppointmentDays(chatId);
        return;
      }

      console.log(`[APPOINTMENT] Time selected chatId=${chatId}, time=${time}`);
      await askAppointmentName(chatId, time);
      return;
    }

    if (data === "confirm_appointment") {
      const appointment = userSessions[chatId];

      if (
        !isAppointmentSession(appointment) ||
        !appointment.day ||
        !appointment.time ||
        !appointment.name ||
        !appointment.phone
      ) {
        await showAppointmentDays(chatId);
        return;
      }

      console.log(
        `[APPOINTMENT] Confirmed chatId=${chatId}, day=${appointment.day}, time=${appointment.time}, name=${appointment.name}, phone=${appointment.phone}`
      );

      await bot.sendMessage(
        chatId,
        "Вы успешно записаны! С вами свяжется администратор."
      );

      delete userSessions[chatId];
      return;
    }

    if (data === "cancel_appointment") {
      delete userSessions[chatId];
      await bot.sendMessage(chatId, "Запись отменена.");
    }
  } catch (error) {
    console.log(`[APPOINTMENT] Callback error chatId=${chatId}:`, error);
    await bot.sendMessage(chatId, "Не удалось оформить запись. Попробуйте ещё раз.");
  }
});

bot.on("polling_error", (error) => {
  console.log("[TELEGRAM] Polling error:", error.message);
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Telegram anamnesis bot",
    models: GEMINI_MODELS,
    endpoints: ["POST /chat"],
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Internal chat endpoint: ${CHAT_URL}`);
  console.log(`Gemini models: ${GEMINI_MODELS.join(", ")}`);
  console.log("Telegram bot polling started");
});
