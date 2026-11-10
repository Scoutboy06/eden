import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  MultiplicationSignCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";

export const toast = ToastPrimitive.createToastManager();

export function Toaster(props: ToastPrimitive.Provider.Props) {
  return (
    <ToastPrimitive.Provider toastManager={toast} {...props}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-auto max-w-sm outline-none sm:right-4 sm:left-auto sm:mx-0 sm:w-full">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((item) => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      className="group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-2xl border bg-popover text-popover-foreground shadow-lg will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))] h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms] after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[''] data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))] data-limited:opacity-0 data-starting-style:[transform:translateY(150%)] [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)] data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))] data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))] data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))] data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))] motion-reduce:transition-none"
    >
      <ToastPrimitive.Content className="flex h-full items-center gap-3 overflow-hidden p-4 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100">
        {(item.type === "success" || item.type === "error") && (
          <HugeiconsIcon
            icon={item.type === "success" ? CheckmarkCircle02Icon : MultiplicationSignCircleIcon}
            aria-hidden
            className={
              item.type === "error" ? "size-4 shrink-0 text-destructive" : "size-4 shrink-0"
            }
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastPrimitive.Title className="text-sm font-medium" />
          <ToastPrimitive.Description className="text-sm text-muted-foreground" />
        </div>
        <ToastPrimitive.Action
          render={<Button variant="outline" size="sm" />}
          className="shrink-0"
        />
        <ToastPrimitive.Close
          aria-label="Close toast"
          render={<Button variant="ghost" size="icon-sm" />}
          className="relative shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} aria-hidden />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}
