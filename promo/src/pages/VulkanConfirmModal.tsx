import React from 'react';
import {Btn, Modal} from '../ui/lw';

// Replica of app/components/VulkanDownloadConfirmModal.vue (Vulkan 确认框), dark mode.
// Pure component: all states controlled by props.
// Native app coordinates: 1440 x 810.

const MODAL_W = 500;
const MODAL_TOP = 440;

export const VULKAN_CONFIRM_LAYOUT = {
  modal: {x: 720, y: 515, w: MODAL_W, h: 151},
  confirmBtn: {x: 896, y: 565},
  cancelBtn: {x: 813, y: 565},
} as const;

export type VulkanConfirmModalProps = {
  open?: boolean;
  enter?: number;
  confirmPressed?: number;
  cancelPressed?: number;
};

export const VulkanConfirmModal: React.FC<VulkanConfirmModalProps> = ({
  open = true,
  enter = 1,
  confirmPressed = 0,
  cancelPressed = 0,
}) => {
  if (!open || enter <= 0.001) return null;

  return (
    <Modal
      width={MODAL_W}
      top={MODAL_TOP}
      left="50%"
      enter={enter}
      title="下载实验性的 Vulkan 运行库？"
      description="Vulkan 版是实验性功能，尚未在 Intel / AMD 真机硬件上进行完整验证。如果遇到兼容性问题或启动失败，CPU 版本仍作为兜底保障。确认现在下载吗？"
      footer={
        <>
          <Btn
            size="sm"
            variant="ghost"
            label="取消"
            pressed={cancelPressed}
          />
          <Btn
            size="sm"
            variant="primary"
            label="下载 Vulkan 版"
            pressed={confirmPressed}
          />
        </>
      }
    />
  );
};
