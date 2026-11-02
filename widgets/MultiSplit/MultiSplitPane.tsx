import { clamp } from 'common/core';
import { debounce } from 'common/timeout';
import React, { ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { Collapse } from 'src/frontend/components/Collapse';
import { useMutationObserver } from 'src/frontend/hooks/useMutationObserver';

export type MultiSplitPaneProps = React.HTMLAttributes<HTMLDivElement> & {
  id: string;
  title: string;
  /** Will be set by the MultiSplit parent */
  isCollapsed?: boolean;
  /** Will be set by the MultiSplit parent */
  setCollapsed?: (isCollapsed: boolean) => void;
  height?: number;
  setHeight?: (height: number) => void;
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  headerToolbar?: ReactNode;
  className?: string;
  onReorderPanel?: (sourceId: string, targetId: string) => void;
};

const ResizableCollapse = ({
  isCollapsed,
  height,
  setHeight,
  children,
}: Pick<MultiSplitPaneProps, 'isCollapsed' | 'height' | 'children'> & {
  setHeight: (height: number) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // Keep track of the resizable height of this component so it can be persistent
  const debouncedSetHeight = useMemo(() => debounce(setHeight, 100), [setHeight]);
  useMutationObserver(
    ref,
    (mutations) => {
      const heightStr = (mutations[0]?.target as HTMLDivElement).style.height.replace('px', '');
      const height = Number(heightStr) || 0;
      if (height !== 0) {
        const maxHeight = window.innerHeight;
        debouncedSetHeight(clamp(height, 0, maxHeight));
      }
    },
    { attributes: true },
  );

  useLayoutEffect(() => {
    if (!ref.current) return;
    const newHeight = isCollapsed ? '0px' : `${height ? `${height}px` : ''}`;
    ref.current.style.height = newHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCollapsed]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    if (height === 0) ref.current.style.height = '0px';
  }, [height]);

  return (
    <div ref={ref} className="resizable-collapse">
      <Collapse open={!isCollapsed}>{children}</Collapse>
    </div>
  );
};

const MultiSplitPane: React.FC<MultiSplitPaneProps> = ({
  title,
  id,
  isCollapsed,
  setCollapsed,
  height,
  setHeight,
  children,
  className,
  headerToolbar,
  headerProps,
  onReorderPanel,
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const draggedPanelId = useRef<string | null>(null);

  return (
    <div className={`section ${className || ''}`} {...props} ref={ref}>
      <header
        {...(headerProps || {})}
        onDragOver={(event) => {
          if (draggedPanelId.current || event.dataTransfer.types.includes('text/outliner-panel')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
          headerProps?.onDragOver?.(event);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = event.dataTransfer.getData('text/outliner-panel');
          if (sourceId && sourceId !== id) onReorderPanel?.(sourceId, id);
          draggedPanelId.current = null;
          headerProps?.onDrop?.(event);
        }}
      >
        <h2
          draggable={!!onReorderPanel}
          title={onReorderPanel ? 'Drag to reorder panels' : undefined}
          onDragStart={(event) => {
            draggedPanelId.current = id;
            event.dataTransfer.setData('text/outliner-panel', id);
            event.dataTransfer.effectAllowed = 'move';
            event.currentTarget.closest('header')?.classList.add('panel-dragging');
          }}
          onDragEnd={(event) => {
            draggedPanelId.current = null;
            event.currentTarget.closest('header')?.classList.remove('panel-dragging');
          }}
          onClick={() => setCollapsed?.(!isCollapsed)}
          onDoubleClick={() => setHeight?.(0)}
        >
          {title}
        </h2>
        {headerToolbar}
      </header>
      {setHeight ? (
        <ResizableCollapse isCollapsed={isCollapsed} setHeight={setHeight} height={height}>
          {children}
        </ResizableCollapse>
      ) : (
        <Collapse open={!isCollapsed}>{children}</Collapse>
      )}
    </div>
  );
};

export default MultiSplitPane;
