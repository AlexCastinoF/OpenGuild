import React, { useState, useRef, useEffect, useId } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import '../styles/custom-select.css';

export interface CustomSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}

export interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

export function CustomSelect({
  value,
  onChange,
  options,
  placeholder = 'Selecione...',
  disabled = false,
  className = '',
  id,
  'aria-label': ariaLabel,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpwards, setOpenUpwards] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const selectId = id || generatedId;

  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.label : placeholder;

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      // Se houver pouco espaço embaixo (< 220px) e mais espaço acima, abre pra cima
      if (spaceBelow < 220 && spaceAbove > spaceBelow) {
        setOpenUpwards(true);
      } else {
        setOpenUpwards(false);
      }
    }
    setIsOpen((prev) => !prev);
  };

  const handleSelect = (option: CustomSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // Rola o item selecionado para a visão quando o menu abrir
  useEffect(() => {
    if (isOpen && listRef.current) {
      const activeItem = listRef.current.querySelector<HTMLElement>('.custom-select-option.is-selected');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={selectId}
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel || displayLabel}
        disabled={disabled}
        onClick={handleToggle}
      >
        <span className="custom-select-label" title={selectedOption?.label || displayLabel}>
          {selectedOption?.icon && <span className="custom-select-icon">{selectedOption.icon}</span>}
          {displayLabel}
        </span>
        <ChevronDown
          size={16}
          className={`custom-select-arrow ${isOpen ? 'is-rotated' : ''}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={selectId}
          className={`custom-select-menu ${openUpwards ? 'opens-up' : 'opens-down'}`}
        >
          {options.length === 0 ? (
            <div className="custom-select-empty">Nenhuma opção disponível</div>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  className={`custom-select-option ${isSelected ? 'is-selected' : ''} ${
                    option.disabled ? 'is-disabled' : ''
                  }`}
                  onClick={() => handleSelect(option)}
                  title={option.label}
                >
                  <div className="custom-select-option-content">
                    {option.icon && <span className="custom-select-option-icon">{option.icon}</span>}
                    <span className="custom-select-option-label">{option.label}</span>
                    {option.sublabel && (
                      <span className="custom-select-option-sublabel">{option.sublabel}</span>
                    )}
                  </div>
                  {isSelected && (
                    <Check size={14} className="custom-select-check" aria-hidden="true" />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
