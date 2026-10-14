/**
 * MacroBoard - custom Blockly fields
 *
 * Three field types:
 *
 *   MB_field_button   a pill showing the chosen key/mouse button. Clicking it
 *                     opens the button-picker modal (US keyboard grid + "listen
 *                     for a press").
 *   MB_field_colour   a colour swatch + hex. Clicking opens the colour modal
 *                     (palette, hex entry, screen eyedropper).
 *   MB_field_action   a generic clickable pill that runs a named action on the
 *                     UI (coordinate picker, chooser arrows / + / x, record
 *                     hotkey). Its value is just its own label.
 *
 * IMPORTANT: this file stays DOM-free at module scope and in field
 * constructors, so block definitions can be loaded in a headless test process.
 * All real UI work is deferred to `showEditor_`, which only runs in the
 * rendered Electron window, and it goes through an injected "ui port" that the
 * renderer installs at startup.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.fields = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The UI port. The renderer replaces this with real modal openers. */
  var ui = {
    ready: false,
    describe: null,
    openButtonPicker: function () { return Promise.resolve(null); },
    openColourPicker: function () { return Promise.resolve(null); },
    runAction: function () {},
  };

  function setUiPort(port) {
    ui = Object.assign(ui, port, { ready: true });
  }

  function svg(tag, attrs, parent, Blockly) {
    var make = Blockly.utils && Blockly.utils.dom && Blockly.utils.dom.createSvgElement;
    if (make) return make(tag, attrs || {}, parent);
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, attrs[k]);
    });
    if (parent) parent.appendChild(el);
    return el;
  }

  /**
   * Base for the bordered pill fields: a rounded background rect plus a text
   * label, sized to the content.
   */
  function defineFields(Blockly) {
    var Field = Blockly.Field;

    class PillField extends Field {
      constructor(value, validator, config) {
        super(value === undefined ? '' : value, validator, config);
        // Blockly's Field constructor assigns these as OWN instance properties,
        // which would shadow anything set on the prototype. Setting them here is
        // therefore the only reliable way to declare a custom field's
        // serializability. (Without it Blockly logs a long warning on every save.)
        this.SERIALIZABLE = true;
        // These fields open a modal rather than editing inline. Clickability in
        // Blockly 13 is decided by whether showEditor_ is overridden (see
        // Field.isClickable), NOT by EDITABLE, so this is safe and stops Blockly
        // treating them as inline text editors.
        this.EDITABLE = false;
        this.tooltipText_ = (config && config.tooltip) || '';
      }

      initView() {
        // createBorderRect_ + createTextElement_ is the documented way to give a
        // custom field a background pill. Blockly's own updateSize_ sizes the
        // border rect from the text that the base class renders, so there is
        // deliberately NO updateSize_ override here.
        //
        // DO NOT add one: an override that calls this.getSize() recurses forever,
        // because Blockly's getSize() calls updateSize_() when the field is dirty.
        // (That bug silently broke every toolbox category, because the thrown
        // RangeError aborted flyout inflation.)
        this.createBorderRect_();
        this.createTextElement_();
        if (this.fieldGroup_) this.fieldGroup_.classList.add('blocklyField');
        if (this.borderRect_) {
          this.borderRect_.setAttribute('rx', '6');
          this.borderRect_.setAttribute('ry', '6');
        }
      }

      /** Every pill is clickable even though it is not a text editor. */
      isClickable() {
        return true;
      }

      getDisplayText_() {
        return this.getText_();
      }

      /**
       * Never let Blockly's lookup for a focusable node throw.
       *
       * Blockly's base implementation raises "This field currently has no
       * representative DOM element" whenever `fieldGroup_` is unset. Worse, it
       * calls this on EVERY field of a block while hunting for somewhere to put
       * the caret - which happens the instant you click a pill, because
       * setStartField -> focusNode -> lookUpFocusableNode walks the whole block.
       *
       * So one field without a group does not fail that field, it fails the
       * click, leaves the gesture half-started, and every later gesture then
       * dies with "the gesture had already been started".
       *
       * Falling back to the owning block's group is both safe and correct: the
       * block is a real SVGElement whenever it is on screen, and focusing the
       * block you just clicked is the sensible outcome anyway.
       */
      getFocusableElement() {
        if (this.fieldGroup_) return this.fieldGroup_;
        const src = typeof this.getSourceBlock === 'function' ? this.getSourceBlock() : null;
        return (src && src.svgGroup) || null;
      }
    }
    PillField.prototype.DEFAULT_VALUE = '';
    // Blockly warns loudly unless a named custom field declares SERIALIZABLE.
    PillField.prototype.SERIALIZABLE = true;
    // These fields open a modal rather than editing inline. Clickability in
    // Blockly 13 is decided by whether showEditor_ is overridden (see
    // Field.isClickable), NOT by EDITABLE, so this is safe and stops Blockly
    // treating them as inline text editors.
    PillField.prototype.EDITABLE = false;

    return { PillField: PillField, Field: Field };
  }

  // ------------------------------------------------- button picker field

  function defineButtonField(Blockly, PillField) {
    class FieldButtonPicker extends PillField {
      constructor(value, validator, config) {
        super(value === undefined || value === null ? '' : value, validator, config);
        // 'action' = must be simulatable; 'trigger' = anything detectable is OK.
        this.mode_ = (config && config.mode) || 'action';
        // 'key' | 'mouse' | null. Restricts the picker to one kind of input so a
        // click block can never end up holding a keyboard key (which would only
        // fail later, at run time, as an opaque library error).
        this.kind_ = (config && config.kind) || null;
        this.describe_ = (config && config.describe) || null;
      }

      static fromJson(options) {
        return new FieldButtonPicker(options.value, undefined, options);
      }

      getText_() {
        if (!this.value_) return '\u25cc  pick a key';
        // Config-supplied describer first (works headlessly), then the live UI port.
        var describe = this.describe_ || ui.describe;
        var label = describe ? describe(this.value_) : String(this.value_);
        return label.replace(/\s*\(reported as code \d+\)$/i, '');
      }

      /** Open the picker modal, which reports back a button id (or null). */
      showEditor_() {
        var self = this;
        var request = {
          value: this.value_ || '',
          mode: this.mode_,
          kind: this.kind_,
          onPick: function (id) {
            if (id) self.setValue(id);
          },
        };
        try {
          Promise.resolve(ui.openButtonPicker(request)).then(function (id) {
            if (id) self.setValue(id);
          });
        } catch (err) {
          /* a failing picker must never break the editor */
        }
      }
    }
    return FieldButtonPicker;
  }

  // -------------------------------------------------------- action field

  /**
   * Generic clickable pill. `action` names a handler registered through the UI
   * port; the field hands the handler its own source block so the handler can
   * read/write sibling fields (that is how "pick on screen" fills in x and y).
   */
  function defineActionField(Blockly, PillField) {
    class FieldAction extends PillField {
      constructor(value, validator, config) {
        super(value === undefined || value === null ? '  ' : value, validator, config);
        this.action_ = (config && config.action) || '';
        // Action pills are chrome, not data: never serialized, never "editable".
        this.SERIALIZABLE = false;
        this.EDITABLE = false;
      }

      static fromJson(options) {
        return new FieldAction(options.text, undefined, options);
      }

      getText_() {
        return this.value_ || '  ';
      }

      /** Action pills are chrome: they must not be serialized into the JSON. */
      saveState() {
        return null;
      }

      loadState() {
        /* nothing to restore */
      }

      isSerializable() {
        return false;
      }

      showEditor_() {
        try {
          // `sourceBlock`, not `getSourceBlock`. Blockly renamed it, and
          // `getSourceBlock` survives on some builds as an own property that is
          // not callable - so the old name threw inside the click handler and
          // "pick" silently did nothing. Feature-detect instead of assuming.
          const src =
            typeof this.getSourceBlock === 'function'
              ? this.getSourceBlock()
              : this.sourceBlock || null;
          ui.runAction(this.action_, src, this);
        } catch (err) {
          /* ignore */
        }
      }
    }
    // Action pills are chrome, not data: they are never serialized.
    FieldAction.prototype.SERIALIZABLE = false;
    return FieldAction;
  }

  // -------------------------------------------------------- switch field

  /**
   * A sliding on/off switch, used for the trigger blocks' "sleep" toggle.
   *
   * It SUBCLASSES Blockly's FieldCheckbox rather than being built from Field,
   * which is what keeps it free: the value is still the boolean TRUE/FALSE,
   * the XML is byte-identical to a checkbox's, and doClassValidation_ is
   * already correct. That matters because macros saved before this existed
   * store `SUPPRESS` as "TRUE"/"FALSE" and must keep loading unchanged.
   *
   * Only the rendering differs: a track with a knob that slides, plus the label
   * beside it. Everything about how the value is stored is inherited, so there
   * is no second code path to keep in sync with the compiler.
   */
  function defineSwitchField(Blockly) {
    var Checkbox = Blockly.FieldCheckbox;

    /** Track geometry, in the block's own user units. */
    var TRACK_W = 26;
    var TRACK_H = 14;
    var KNOB_R = 5;
    var KNOB_INSET = 2;
    var LABEL_GAP = 5;
    /** Reserved width for the label, so the field never resizes when toggling. */
    var LABEL_EST_WIDTH = 40;

    class FieldSwitch extends Checkbox {
      constructor(value, validator, config) {
        super(value === undefined ? true : value, validator, config);
        this.SERIALIZABLE = true;
        this.EDITABLE = false;
        this.label_ = (config && config.label) || '';
        this.onTooltip_ = (config && config.onTooltip) || '';
        this.offTooltip_ = (config && config.offTooltip) || '';
      }

      static fromJson(options) {
        return new FieldSwitch(options.value, undefined, options);
      }

      /**
       * The switch is a control, not a label, so its border IS the track.
       */
      isClickable() {
        return true;
      }

      /**
       * Redraw when the value changes.
       *
       * This override is the whole reason the switch works. FieldCheckbox's
       * doValueUpdate_ only hides/shows its own text element and recomputes ARIA
       * - it NEVER calls render_. So a subclass that draws its state in render_
       * would silently keep showing the old state after a click: the knob would
       * not move and the track would not change colour, even though the value
       * had toggled correctly. Calling render_ here is what makes the visible
       * state follow the stored one.
       *
       * The text element is forced visible first, because the base class hides
       * it when unchecked, which for a switch would hide the label in the
       * "off" position - the one state where the user most needs the label.
       */
      doValueUpdate_(newValue) {
        super.doValueUpdate_(newValue);
        if (this.textElement_) this.textElement_.style.display = 'block';
        this.render_();
      }

      initView() {
        super.initView();
        var group = this.fieldGroup_;
        if (group) group.classList.add('mbSwitchField');
        // The base class adds `blocklyCheckboxField` and hides the text element
        // when the value is false. That hidden-text behaviour is exactly wrong
        // for a switch, whose label must stay visible in both states.
        if (this.textElement_) this.textElement_.style.display = 'block';
        if (this.borderRect_) this.borderRect_.setAttribute('class', 'mbSwitchTrack');

        this.knob_ = svg(
          'circle',
          { r: KNOB_R, class: 'mbSwitchKnob' },
          this.getClickTarget_(),
          Blockly
        );
        this.applyGeometry_();
      }

      /**
       * Size the track, place the label, and reserve the right total width.
       *
       * updateSize_ is given the width the field should OCCUPY on the block,
       * which is the track plus the label. Calling it with an explicit width
       * (rather than letting Blockly measure the text) is what keeps the switch
       * a fixed size: the label text length must not change the field's footprint.
       */
      applyGeometry_() {
        var fieldH = this.getConstants().FIELD_HEIGHT;
        if (this.borderRect_) {
          this.borderRect_.setAttribute('width', TRACK_W);
          this.borderRect_.setAttribute('height', TRACK_H);
          this.borderRect_.setAttribute('x', 0);
          this.borderRect_.setAttribute('y', (fieldH - TRACK_H) / 2);
          this.borderRect_.setAttribute('rx', TRACK_H / 2);
          this.borderRect_.setAttribute('ry', TRACK_H / 2);
        }
        if (this.textElement_) {
          this.textElement_.setAttribute('x', TRACK_W + LABEL_GAP);
          this.textElement_.setAttribute('y', fieldH / 2);
          this.textElement_.setAttribute('dominant-baseline', 'central');
        }
        this.render_();
        this.updateSize_(TRACK_W + LABEL_GAP + LABEL_EST_WIDTH);
      }

      render_() {
        var on = this.getValueBoolean();
        var travel = TRACK_W - 2 * KNOB_INSET - 2 * KNOB_R;

        // The knob MOVES VIA A CSS TRANSFORM, not by rewriting cx. SVG geometry
        // attributes are not animatable in CSS, so a `transition: fill` on the
        // knob would do nothing; transform is, which is what makes it slide.
        // The circle is drawn at its OFF position and translated from there.
        if (this.knob_) {
          this.knob_.setAttribute('cx', KNOB_INSET + KNOB_R);
          this.knob_.setAttribute('cy', TRACK_H / 2);
          this.knob_.style.transform = 'translateX(' + (on ? travel : 0) + 'px)';
        }
        if (this.borderRect_) this.borderRect_.setAttribute('class', on ? 'mbSwitchTrack is-on' : 'mbSwitchTrack');
        if (this.textContent_) this.textContent_.nodeValue = this.label_;
        if (this.fieldGroup_) this.fieldGroup_.setAttribute('data-state', on ? 'on' : 'off');
      }

      getDisplayText_() {
        return this.label_ || 'on';
      }

      getText_() {
        return this.label_;
      }

      /** Hover text that describes what clicking will DO, not current state. */
      showEditor_() {
        var willTurnOn = !this.getValueBoolean();
        var tip = willTurnOn ? this.onTooltip_ : this.offTooltip_;
        if (tip) this.setTooltip(tip);
        super.showEditor_();
      }
    }

    FieldSwitch.prototype.SERIALIZABLE = true;
    FieldSwitch.prototype.DEFAULT_VALUE = true;
    return FieldSwitch;
  }

  // ------------------------------------------------- colour picker field

  function defineColourField(Blockly, PillField) {
    class FieldColourPicker extends PillField {
      constructor(value, validator, config) {
        super(value === undefined || value === null ? '#ffffff' : value, validator, config);
      }

      static fromJson(options) {
        return new FieldColourPicker(options.value, undefined, options);
      }

      initView() {
        super.initView();
        // A swatch sitting in front of the hex text.
        this.swatch_ = svg(
          'rect',
          { x: '-2', y: '1', width: '8', height: '8', rx: '2', fill: this.normalise_(this.value_) },
          this.getClickTarget_(),
          Blockly
        );
        if (this.borderRect_ && this.swatch_) {
          this.borderRect_.parentNode.insertBefore(this.swatch_, this.borderRect_.nextSibling);
        }
      }

      render_() {
        if (typeof super.render_ === 'function') super.render_();
        if (this.swatch_) this.swatch_.setAttribute('fill', this.normalise_(this.value_));
      }

      normalise_(v) {
        return /^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : '#ffffff';
      }

      getText_() {
        return '  ' + this.normalise_(this.value_).toUpperCase();
      }

      doClassValidation_(newValue) {
        if (newValue === null || newValue === undefined) return null;
        var v = String(newValue).trim();
        if (/^[0-9a-fA-F]{6}$/.test(v)) v = '#' + v;
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
      }

      showEditor_() {
        var self = this;
        try {
          Promise.resolve(
            ui.openColourPicker({
              value: this.normalise_(this.value_),
              onPick: function (hex) {
                if (hex) self.setValue(hex);
              },
            })
          ).then(function (hex) {
            if (hex) self.setValue(hex);
          });
        } catch (err) {
          /* ignore */
        }
      }
    }
    return FieldColourPicker;
  }

  /**
   * Define + register the fields against a Blockly instance.
   * Safe to call once at startup (renderer) or headlessly in tests.
   */
  function register(Blockly, deps) {
    var made = defineFields(Blockly);
    var button = defineButtonField(Blockly, made.PillField);
    var colour = defineColourField(Blockly, made.PillField);
    var action = defineActionField(Blockly, made.PillField);
    var toggle = defineSwitchField(Blockly);

    Blockly.fieldRegistry.register('field_mb_button', button);
    Blockly.fieldRegistry.register('field_mb_colour', colour);
    Blockly.fieldRegistry.register('field_mb_action', action);
    Blockly.fieldRegistry.register('field_mb_switch', toggle);

    if (deps && deps.ui) setUiPort(deps.ui);

    return {
      PillField: made.PillField,
      FieldButtonPicker: button,
      FieldColourPicker: colour,
      FieldAction: action,
      FieldSwitch: toggle,
    };
  }

  return {
    _defineFields: defineFields,
    register: register,
    setUiPort: setUiPort,
    getUiPort: function () {
      return ui;
    },
  };
});
