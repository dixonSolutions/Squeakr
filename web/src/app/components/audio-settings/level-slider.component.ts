/**
 * A 0–100 slider whose middle is the default (docs/49).
 *
 * Every device-level control on the Audio page and the wake sensitivity
 * control share this, so they all read the same way: a tick marks the
 * default, the ends are labelled in words, the current value is spelled out
 * in real units, and one tap puts it back to the middle.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Slider } from '@openng/optimus-ui/slider';

@Component({
  selector: 'cv-level-slider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Slider],
  template: `
    <div class="cv-level" [class.cv-level--disabled]="disabled()">
      <div class="cv-level-head">
        <span class="cv-level-label" [id]="inputId() + '-label'">
          @if (icon()) { <i [class]="'pi ' + icon()"></i> }
          {{ label() }}
        </span>
        <span class="cv-level-value" [class.cv-level-value--default]="isDefault()" aria-live="polite">
          {{ valueLabel() }}
        </span>
        <button type="button" class="cv-level-reset" (click)="reset()"
          [disabled]="disabled() || isDefault()"
          [attr.aria-label]="'Reset ' + label() + ' to default'" title="Reset to default">
          <i class="pi pi-undo"></i>
        </button>
      </div>
      <div class="cv-level-track">
        <span class="cv-level-tick" aria-hidden="true"></span>
        <p-slider [ngModel]="value()" (ngModelChange)="onSlide($event)"
          (onSlideEnd)="committed.emit(value())"
          [min]="0" [max]="100" [step]="1" [disabled]="disabled()"
          [ariaLabelledBy]="inputId() + '-label'" [attr.data-testid]="inputId()" />
      </div>
      <div class="cv-level-ends" aria-hidden="true">
        <span>{{ minLabel() }}</span>
        <span>Default</span>
        <span>{{ maxLabel() }}</span>
      </div>
      @if (hint()) {
        <div class="cv-level-hint">{{ hint() }}</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .cv-level { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.25rem 0; }
    .cv-level--disabled { opacity: 0.55; }
    .cv-level-head { display: flex; align-items: center; gap: 0.5rem; }
    .cv-level-label {
      font-weight: 600; font-size: 0.95rem; display: inline-flex; align-items: center; gap: 0.45rem;
      flex: 1; min-width: 0;
    }
    .cv-level-label .pi { color: var(--p-primary-color); }
    .cv-level-value {
      font-variant-numeric: tabular-nums; font-size: 0.85rem; font-weight: 600;
      padding: 0.15rem 0.55rem; border-radius: 999px;
      background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
      color: var(--p-primary-color); white-space: nowrap;
    }
    .cv-level-value--default {
      background: color-mix(in srgb, var(--p-text-muted-color) 14%, transparent);
      color: var(--p-text-muted-color);
    }
    .cv-level-reset {
      border: 0; background: transparent; color: var(--p-text-muted-color); cursor: pointer;
      width: 2rem; height: 2rem; border-radius: 50%; display: grid; place-items: center;
    }
    .cv-level-reset:hover:not(:disabled) {
      background: color-mix(in srgb, var(--p-text-muted-color) 14%, transparent);
      color: var(--p-text-color);
    }
    .cv-level-reset:disabled { opacity: 0.35; cursor: default; }
    .cv-level-reset:focus-visible { outline: 2px solid var(--p-focus-ring-color, var(--p-primary-color)); }
    /* Generous vertical padding: the handle must be easy to grab on a phone. */
    .cv-level-track { position: relative; padding: 0.85rem 0.6rem; touch-action: pan-y; }
    .cv-level-tick {
      position: absolute; left: 50%; top: 50%; width: 2px; height: 1.1rem;
      transform: translate(-50%, -50%); border-radius: 1px;
      background: var(--p-text-muted-color); opacity: 0.6; pointer-events: none;
    }
    .cv-level-ends {
      display: grid; grid-template-columns: 1fr auto 1fr; font-size: 0.75rem;
      color: var(--p-text-muted-color);
    }
    .cv-level-ends span:last-child { text-align: right; }
    .cv-level-hint { font-size: 0.8rem; color: var(--p-text-muted-color); }
  `,
})
export class LevelSliderComponent {
  readonly value = input.required<number>();
  readonly label = input.required<string>();
  readonly inputId = input.required<string>();
  readonly valueLabel = input<string>('');
  readonly minLabel = input('Less');
  readonly maxLabel = input('More');
  readonly icon = input<string>('');
  readonly hint = input<string>('');
  readonly disabled = input(false);

  /** Every movement, while dragging — for live preview. */
  readonly valueChange = output<number>();
  /** Drag released (or reset) — for saving. */
  readonly committed = output<number>();

  protected readonly isDefault = computed(() => Math.round(this.value()) === 50);

  protected onSlide(next: number): void {
    // Magnetic middle: within 2 of the default snaps to it, so it can be found by feel.
    const snapped = Math.abs(next - 50) <= 2 ? 50 : next;
    this.valueChange.emit(snapped);
  }

  protected reset(): void {
    this.valueChange.emit(50);
    this.committed.emit(50);
  }
}
