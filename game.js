(function () {
  "use strict";
  var CFG = window.GAME_CONFIG || {};
  var ONLINE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY);
  var ROUND = CFG.ROUND_SIZE || 20;
  var MAX_PENALTY = 3;

  // ---------- данные (слова зашифрованы от подглядывания) ----------
  var WORDS = (function () {
    var D = window.GAME_DATA, bin = atob(D.t), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ D.k[i % D.k.length];
    return JSON.parse(new TextDecoder().decode(bytes)).map(function (w, i) { w.i = i; return w; });
  })();

  var $ = function (id) { return document.getElementById(id); };
  function show(id) { ["scrLogin", "scrGame", "scrEnd"].forEach(function (s) { $(s).classList.toggle("hidden", s !== id); }); }
  function norm(s) { return (s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); }
  function lev(a, b) {
    var m = a.length, n = b.length, prev = [], cur, i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur = [i];
      for (j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function plural(n, a, b, c) { n = Math.abs(n) % 100; var d = n % 10; if (n > 10 && n < 20) return c; if (d === 1) return a; if (d >= 2 && d <= 4) return b; return c; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---------- хранилище: Supabase или локально ----------
  function rpc(fn, body) {
    return fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_KEY },
      body: JSON.stringify(body || {})
    }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  var local = {
    get: function () { try { return JSON.parse(localStorage.getItem("vocab_players") || "{}"); } catch (e) { return {}; } },
    put: function (p) { try { localStorage.setItem("vocab_players", JSON.stringify(p)); } catch (e) {} }
  };
  var api = ONLINE ? {
    login: function (n, p) { return rpc("login", { p_name: n, p_pin: p }); },
    submit: function (n, p, s) { return rpc("submit_score", { p_name: n, p_pin: p, p_score: s }); },
    board: function () { return rpc("leaderboard"); }
  } : {
    login: function (n, p) {
      var all = local.get(), k = n.toLowerCase();
      if (!all[k]) { all[k] = { name: n, pin: p, best_score: 0, games: 0 }; local.put(all); return Promise.resolve("created"); }
      return Promise.resolve(all[k].pin === p ? "ok" : "wrong_pin");
    },
    submit: function (n, p, s) {
      var all = local.get(), r = all[n.toLowerCase()];
      if (!r || r.pin !== p) return Promise.resolve({ status: "wrong_pin" });
      r.best_score = r.games === 0 ? s : Math.max(r.best_score, s); r.games++; r.best_at = Date.now(); local.put(all);
      return Promise.resolve({ status: "ok", best: r.best_score, games: r.games });
    },
    board: function () {
      var all = local.get();
      return Promise.resolve(Object.keys(all).map(function (k) { return all[k]; }).filter(function (r) { return r.games > 0; })
        .sort(function (a, b) { return b.best_score - a.best_score; }));
    }
  };

  function renderBoard(target) {
    var el = $(target);
    el.innerHTML = '<p class="note">Загружаю…</p>';
    api.board().then(function (rows) {
      if (!rows.length) { el.innerHTML = '<p class="note">Пока никто не играл — стань первым!</p>'; return; }
      var me = state.name.toLowerCase();
      el.innerHTML = '<table><tr><th>#</th><th>Игрок</th><th class="n">Рекорд</th><th class="n">Игр</th></tr>' +
        rows.map(function (r, i) {
          return '<tr' + (r.name.toLowerCase() === me ? ' class="me"' : "") + "><td>" + (i + 1) + "</td><td>" + esc(r.name) +
            '</td><td class="n">' + r.best_score + '</td><td class="n">' + r.games + "</td></tr>";
        }).join("") + "</table>" +
        (ONLINE ? "" : '<p class="note">Табло пока хранится только на этом устройстве (Supabase не подключён).</p>');
    }).catch(function () { el.innerHTML = '<p class="note">Не удалось загрузить табло. Проверьте интернет.</p>'; });
  }

  // ---------- состояние партии ----------
  var state = { name: "", pin: "", score: 0, queue: [], pos: 0, stage: "", repeat: [] };
  try { $("inName").value = localStorage.getItem("vocab_last_name") || ""; } catch (e) {}

  function start() {
    var n = $("inName").value.trim(), p = $("inPin").value.trim();
    $("loginErr").textContent = "";
    if (!n) { $("loginErr").textContent = "Напиши имя"; return; }
    if (!/^[0-9]{4}$/.test(p)) { $("loginErr").textContent = "PIN — ровно 4 цифры"; return; }
    $("btnStart").disabled = true;
    api.login(n, p).then(function (res) {
      $("btnStart").disabled = false;
      if (res === "wrong_pin") { $("loginErr").textContent = "Такой игрок уже есть, и PIN не совпадает. Если это не ты — возьми другое имя."; return; }
      if (res !== "ok" && res !== "created") { $("loginErr").textContent = "Проверь имя и PIN"; return; }
      state.name = n; state.pin = p;
      try { localStorage.setItem("vocab_last_name", n); } catch (e) {}
      newRound();
    }).catch(function () { $("btnStart").disabled = false; $("loginErr").textContent = "Нет связи с сервером. Попробуй ещё раз."; });
  }

  function newRound() {
    var pool = WORDS.slice();
    for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    state.queue = pool.slice(0, Math.min(ROUND, pool.length));
    state.pos = 0; state.score = 0; state.repeat = [];
    show("scrGame");
    ask();
  }

  function cur() { return state.queue[state.pos]; }

  function ask() {
    var w = cur();
    state.stage = "image";
    $("progress").textContent = "Слово " + (state.pos + 1) + " из " + state.queue.length;
    $("score").textContent = state.score;
    $("pic").src = "data:image/jpeg;base64," + window.GAME_DATA.img[w.i];
    $("defBox").classList.add("hidden");
    $("answerRow").classList.remove("hidden");
    $("btnNext").classList.add("hidden");
    $("fb").className = "fb"; $("fb").textContent = "";
    $("inAnswer").value = ""; $("inAnswer").focus();
  }

  function showDef() {
    var w = cur();
    state.stage = "def";
    $("defText").textContent = w.d;
    $("defSrc").textContent = w.g ? "Определение: gramota.ru" : "Определение не с gramota.ru";
    $("defBox").classList.remove("hidden");
    $("inAnswer").value = ""; $("inAnswer").focus();
  }

  function addRepeat(w) { if (state.repeat.indexOf(w.w) < 0) state.repeat.push(w.w); }

  function finishWord(msg, cls) {
    $("fb").className = "fb " + cls; $("fb").innerHTML = msg;
    $("answerRow").classList.add("hidden");
    $("btnNext").classList.remove("hidden"); setTimeout(function () { $("btnNext").focus(); }, 60);
    $("score").textContent = state.score;
  }

  function reveal(prefix) {
    var w = cur(); addRepeat(w); state.stage = "done";
    finishWord(prefix + 'Правильно пишется: <span class="answer">' + esc(w.w) + "</span>", "bad");
  }

  function check() {
    var w = cur(), a = norm($("inAnswer").value);
    if (!a || state.stage === "done") return;
    if (a === "?") { help(); return; }
    if (a === norm(w.w)) {
      var pts = state.stage === "image" ? 2 : 1;
      state.score += pts; state.stage = "done";
      if (pts === 1) addRepeat(w);
      finishWord("Верно! <b>+" + pts + "</b> — " + '<span class="answer">' + esc(w.w) + "</span>", "good");
      return;
    }
    var target = norm(w.w), d = lev(a, target);
    var isOther = WORDS.some(function (x) { return norm(x.w) === a; });
    var tol = target.length <= 4 ? 1 : target.length <= 8 ? 2 : 3;
    if (!isOther && d <= tol) {
      // слово узнал, но написал с ошибками: штраф по числу ошибок, сразу верное написание
      var errs = Math.min(MAX_PENALTY, d);
      state.score -= errs;
      reveal("Слово угадано, но с " + (errs === 1 ? "ошибкой" : "ошибками") + ": <b>−" + errs + "</b>. ");
      return;
    }
    wrong("Неверно, <b>−1</b>. ");
  }

  // неверное слово или «Не знаю»: −1; после картинки — определение, после определения — ответ
  function wrong(txt) {
    var w = cur();
    state.score -= 1; $("score").textContent = state.score;
    addRepeat(w);
    if (state.stage === "image") {
      showDef();
      $("fb").className = "fb bad"; $("fb").innerHTML = txt + "Вот определение — попробуй ещё раз.";
    } else {
      reveal(txt);
    }
  }

  function help() {
    if (state.stage === "image" || state.stage === "def") wrong("Не знаю: <b>−1</b>. ");
  }

  function next() {
    state.pos++;
    if (state.pos >= state.queue.length) endRound(false); else ask();
  }

  function endRound(stopped) {
    show("scrEnd");
    var answered = state.pos + (state.stage === "done" ? 1 : 0);
    $("endTitle").textContent = stopped ? "Игра остановлена" : "Партия окончена";
    $("endScore").textContent = state.score + " " + plural(state.score, "очко", "очка", "очков");
    $("endBest").textContent = "Слов пройдено: " + answered + " из " + state.queue.length;
    $("repeatBox").innerHTML = state.repeat.length
      ? "<b>Повторить:</b><div class='chips'>" + state.repeat.map(function (w) { return "<span class='chip'>" + esc(w) + "</span>"; }).join("") + "</div>"
      : (answered ? "<b>Все слова угаданы по картинке — блестяще!</b>" : "");
    if (answered === 0) { renderBoard("board2"); return; }
    api.submit(state.name, state.pin, state.score).then(function (r) {
      if (r.status === "ok") $("endBest").textContent += " · твой рекорд: " + r.best + " · игр: " + r.games;
      else $("endBest").textContent += " · результат не записан";
      renderBoard("board2");
    }).catch(function () { $("endBest").textContent += " · нет связи, результат не записан"; renderBoard("board2"); });
  }

  // ---------- события ----------
  $("btnStart").onclick = start;
  $("inPin").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); start(); } });
  $("inName").addEventListener("keydown", function (e) { if (e.key === "Enter") $("inPin").focus(); });
  $("btnCheck").onclick = check;
  $("btnHelp").onclick = help;
  $("inAnswer").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); check(); } });
  $("btnNext").onclick = next;
  $("btnStop").onclick = function () { endRound(true); };
  $("btnAgain").onclick = newRound;
  $("btnLogout").onclick = function () { state.name = state.pin = ""; $("inPin").value = ""; show("scrLogin"); renderBoard("board1"); };
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !$("btnNext").classList.contains("hidden") && document.activeElement !== $("btnNext") && !$("scrGame").classList.contains("hidden")) { e.preventDefault(); next(); }
  });
  renderBoard("board1");
})();
