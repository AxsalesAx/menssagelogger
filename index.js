(function () {
  "use strict";

  // MessageLogger para Revenge (Classic / Vendetta API)
  // Lógica baseada no MessageLogger do Vencord (GPL-3.0):
  // rushii, Ven, AutumnVN, Nickyux, Kyuuhachi, sadan, f3tch.

  var metro = vendetta.metro;
  var instead = vendetta.patcher.instead;
  var store = vendetta.plugin.storage;
  var ui = vendetta.ui;
  var React = metro.common.React;
  var RN = metro.common.ReactNative;
  var FluxDispatcher = metro.common.FluxDispatcher;
  var h = React.createElement;

  var DEFAULTS = {
    logDeletes: true,
    logEdits: true,
    strikeEdits: true,
    ignoreBots: true,
    ignoreSelf: true,
    ignoreUsers: "",
    ignoreChannels: "",
    ignoreGuilds: "",
    deletedMarker: "🗑️ *mensagem apagada*",
    debug: false
  };

  var MAX_ENTRIES = 3000;
  var entries = new Map(); // "canal:id" -> { id, channelId, versions[], current, deleted }
  var MessageStore, UserStore, ChannelStore;
  var unpatch = null;

  function dbg() {
    if (!store.debug) return;
    try { console.log.apply(console, ["[MessageLogger]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  function toast(text) {
    try { ui.toasts.showToast(text); } catch (e) {}
  }

  function parseList(s) {
    return new Set(String(s || "").split(/[\s,;]+/).filter(Boolean));
  }

  function keyOf(channelId, id) { return channelId + ":" + id; }

  function trim() {
    while (entries.size > MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
  }

  function shouldIgnore(msg, channelId, isEdit) {
    try {
      if (isEdit ? !store.logEdits : !store.logDeletes) return true;
      if ((msg.flags & 64) === 64) return true;            // efêmera
      if (msg.state && msg.state !== "SENT") return true;  // enviando / falhou
      var author = msg.author;
      var me = UserStore.getCurrentUser();
      if (store.ignoreBots && author && author.bot) return true;
      if (store.ignoreSelf && author && me && author.id === me.id) return true;
      if (author && parseList(store.ignoreUsers).has(author.id)) return true;
      var chans = parseList(store.ignoreChannels);
      if (chans.has(channelId)) return true;
      var ch = ChannelStore.getChannel(channelId);
      if (ch && ch.parent_id && chans.has(ch.parent_id)) return true;
      if (ch && ch.guild_id && parseList(store.ignoreGuilds).has(ch.guild_id)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function strike(text) {
    return text.split("\n").map(function (l) { return l.trim() ? "~~" + l + "~~" : l; }).join("\n");
  }

  // Monta o texto exibido: versões antigas riscadas + conteúdo atual + marcador de apagada
  function render(e) {
    var parts = [];
    e.versions.forEach(function (v) {
      if (v) parts.push(store.strikeEdits ? strike(v) : v);
    });
    if (e.current) parts.push(e.current);
    if (e.deleted) parts.push(store.deletedMarker || DEFAULTS.deletedMarker);
    return parts.join("\n");
  }

  function updateEvent(channelId, id, guildId, content) {
    return {
      type: "MESSAGE_UPDATE",
      message: { id: id, channel_id: channelId, guild_id: guildId, content: content }
    };
  }

  // Retorna o evento MESSAGE_UPDATE que substitui o delete, ou null para deixar apagar normalmente
  function onDelete(channelId, id) {
    try {
      var msg = MessageStore.getMessage(channelId, id);
      if (!msg || shouldIgnore(msg, channelId, false)) return null;

      var key = keyOf(channelId, id);
      var e = entries.get(key);
      if (!e) {
        e = { id: id, channelId: channelId, versions: [], current: msg.content || "", deleted: false };
        entries.set(key, e);
        trim();
      }
      var ch = ChannelStore.getChannel(channelId);
      var guildId = (ch && ch.guild_id) || msg.guild_id;
      if (e.deleted) return updateEvent(channelId, id, guildId, render(e));
      e.deleted = true;
      dbg("apagada:", key);
      return updateEvent(channelId, id, guildId, render(e));
    } catch (err) {
      console.error("[MessageLogger] erro no onDelete", err);
      return null;
    }
  }

  // Retorna o evento modificado (com histórico de edição), ou null para seguir normal
  function onUpdate(ev) {
    try {
      var m = ev.message;
      if (!m || !m.id || typeof m.content !== "string") return null;
      var channelId = m.channel_id;
      var key = keyOf(channelId, m.id);
      var e = entries.get(key);
      var isEdit = !!m.edited_timestamp;

      if (!e) {
        var stored = MessageStore.getMessage(channelId, m.id);
        if (!stored || !isEdit || m.content === stored.content) return null;
        if (shouldIgnore(stored, channelId, true)) return null;
        e = { id: m.id, channelId: channelId, versions: [stored.content || ""], current: m.content, deleted: false };
        entries.set(key, e);
        trim();
        dbg("editada:", key);
      } else if (!e.deleted && m.content !== e.current) {
        if (isEdit) e.versions.push(e.current);
        e.current = m.content;
      }

      var out = {};
      for (var k in ev) out[k] = ev[k];
      out.message = {};
      for (var k2 in m) out.message[k2] = m[k2];
      out.message.content = render(e);
      return out;
    } catch (err) {
      console.error("[MessageLogger] erro no onUpdate", err);
      return null;
    }
  }

  function clearDeleted() {
    var n = 0;
    entries.forEach(function (e, key) {
      if (e.deleted) {
        FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", id: e.id, channelId: e.channelId, __mlBypass: true });
        entries.delete(key);
        n++;
      }
    });
    toast(n + " mensagem(ns) apagada(s) removida(s) da tela");
  }

  // ---------- Configurações ----------
  function Settings() {
    vendetta.storage.useProxy(store);
    var Forms = ui.components.Forms;

    function sw(key, label, sub) {
      var props = {
        label: label,
        subLabel: sub,
        value: !!store[key],
        onValueChange: function (v) { store[key] = v; }
      };
      if (Forms.FormSwitchRow) return h(Forms.FormSwitchRow, props);
      return h(Forms.FormRow, {
        label: label,
        subLabel: sub,
        trailing: h(Forms.FormSwitch, { value: !!store[key], onValueChange: props.onValueChange })
      });
    }

    function inp(key, title, placeholder) {
      return h(Forms.FormInput, {
        title: title,
        placeholder: placeholder,
        value: store[key],
        onChange: function (v) { store[key] = v; }
      });
    }

    return h(RN.ScrollView, { style: { flex: 1 } },
      h(Forms.FormSection, { title: "Registro" },
        sw("logDeletes", "Registrar mensagens apagadas", "Mantém a mensagem na tela com um aviso"),
        sw("logEdits", "Registrar edições", "Mostra as versões antigas acima da nova"),
        sw("strikeEdits", "Riscar versões antigas", "Versões antigas aparecem ~~riscadas~~")
      ),
      h(Forms.FormSection, { title: "Ignorar" },
        sw("ignoreBots", "Ignorar bots"),
        sw("ignoreSelf", "Ignorar minhas mensagens", "Recomendado: evita bagunçar o texto ao editar"),
        inp("ignoreUsers", "IDs de usuários", "separe por vírgula"),
        inp("ignoreChannels", "IDs de canais", "separe por vírgula"),
        inp("ignoreGuilds", "IDs de servidores", "separe por vírgula")
      ),
      h(Forms.FormSection, { title: "Aparência" },
        inp("deletedMarker", "Aviso de mensagem apagada", DEFAULTS.deletedMarker)
      ),
      h(Forms.FormSection, { title: "Outros" },
        h(Forms.FormRow, {
          label: "Remover mensagens apagadas da tela",
          subLabel: "Apaga de verdade as que foram mantidas pelo plugin",
          onPress: clearDeleted
        }),
        sw("debug", "Modo debug", "Mostra logs no console do Revenge")
      )
    );
  }

  // ---------- Ciclo de vida ----------
  return {
    onLoad: function () {
      for (var k in DEFAULTS) {
        if (store[k] === undefined) store[k] = DEFAULTS[k];
      }

      MessageStore = metro.findByStoreName("MessageStore");
      UserStore = metro.findByStoreName("UserStore");
      ChannelStore = metro.findByStoreName("ChannelStore");
      if (!MessageStore || !UserStore || !ChannelStore) {
        toast("MessageLogger: não achei os stores do Discord");
        console.error("[MessageLogger] stores não encontrados", !!MessageStore, !!UserStore, !!ChannelStore);
        return;
      }

      unpatch = instead("dispatch", FluxDispatcher, function (args, orig) {
        var ev = args[0];
        if (!ev || ev.__mlBypass) return orig.apply(this, args);

        if (ev.type === "MESSAGE_DELETE") {
          var upd = onDelete(ev.channelId, ev.id);
          if (upd) return orig.call(this, upd);
        } else if (ev.type === "MESSAGE_DELETE_BULK") {
          var ids = ev.ids || [];
          var pass = [];
          for (var i = 0; i < ids.length; i++) {
            var u = onDelete(ev.channelId, ids[i]);
            if (u) orig.call(this, u); else pass.push(ids[i]);
          }
          if (!pass.length) return;
          if (pass.length !== ids.length) {
            var copy = {};
            for (var kk in ev) copy[kk] = ev[kk];
            copy.ids = pass;
            return orig.call(this, copy);
          }
        } else if (ev.type === "MESSAGE_UPDATE") {
          var next = onUpdate(ev);
          if (next) return orig.call(this, next);
        }

        return orig.apply(this, args);
      });

      dbg("carregado");
    },

    onUnload: function () {
      if (unpatch) unpatch();
      unpatch = null;
      entries.clear();
    },

    settings: Settings
  };
})()
