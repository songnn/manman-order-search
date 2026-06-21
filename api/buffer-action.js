import {
  completeStorageRequestEvent,
  createBufferEvent,
  createReceivingCount,
  createStorageRequestEvent,
  getOperationsDashboardData,
  setReceivingComplete
} from '../lib/opsData.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      ok: false,
      message: 'POST 요청만 가능합니다.'
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    const body = req.body || {};
    const action = String(body.action || '').trim();

    if (action === 'buffer_delta') {
      await createBufferEvent({
        inventoryStableId: body.inventoryStableId,
        deltaQuantity: body.deltaQuantity,
        actorMemo: body.actorMemo
      });
    } else if (action === 'receive_count') {
      await createReceivingCount({
        inventoryStableId: body.inventoryStableId,
        countedQuantity: body.countedQuantity,
        actorMemo: body.actorMemo
      });
    } else if (action === 'receive_complete') {
      await setReceivingComplete({
        inventoryStableId: body.inventoryStableId,
        isComplete: body.isComplete,
        completedBy: body.completedBy
      });
    } else if (action === 'storage_request_pending') {
      const items = Array.isArray(body.items) && body.items.length
        ? body.items
        : [{
            inventoryStableId: body.inventoryStableId,
            quantity: body.quantity
          }];

      for (const item of items) {
        await createStorageRequestEvent({
          inventoryStableId: item.inventoryStableId,
          quantity: item.quantity,
          customerLabel: body.customerLabel,
          customerDigits4: body.customerDigits4,
          locationMemo: body.locationMemo,
          visitDateText: body.visitDateText,
          requestMemo: body.requestMemo,
          status: 'pending'
        });
      }
    } else if (action === 'storage_request_complete') {
      if (body.eventId) {
        await completeStorageRequestEvent({
          eventId: body.eventId,
          locationMemo: body.locationMemo,
          visitDateText: body.visitDateText,
          requestMemo: body.requestMemo
        });
      } else {
        const items = Array.isArray(body.items) && body.items.length
          ? body.items
          : [{
              inventoryStableId: body.inventoryStableId,
              quantity: body.quantity
            }];

        for (const item of items) {
          await createStorageRequestEvent({
            inventoryStableId: item.inventoryStableId,
            quantity: item.quantity,
            customerLabel: body.customerLabel,
            customerDigits4: body.customerDigits4,
            locationMemo: body.locationMemo,
            visitDateText: body.visitDateText,
            requestMemo: body.requestMemo,
            status: 'completed'
          });
        }
      }
    } else {
      return res.status(400).json({
        ok: false,
        message: '지원하지 않는 액션입니다.'
      });
    }

    const dashboard = await getOperationsDashboardData();
    return res.status(200).json({
      ok: true,
      dashboard
    });
  } catch (error) {
    console.error('buffer-action error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

function isAuthorized(req) {
  const expectedAdmin = process.env.ADMIN_TOKEN || '03064';
  const token = req.headers['x-admin-token'] || req.query?.token;
  return Boolean(expectedAdmin && token === expectedAdmin);
}
