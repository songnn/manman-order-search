import crypto from 'node:crypto';
import {
  createBufferEvent,
  createReceivingCount,
  createStorageRequestEvent,
  getOperationsDashboardData,
  setReceivingComplete,
  updateStorageRequestEvents
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
    const shouldReturnDashboard = body.returnDashboard !== false;
    const storageEvents = [];

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
      const storageGroupId = String(body.storageGroupId || crypto.randomUUID()).trim();
      const items = Array.isArray(body.items) && body.items.length
        ? body.items
        : [{
            inventoryStableId: body.inventoryStableId,
            quantity: body.quantity
          }];

      for (const item of items) {
        const result = await createStorageRequestEvent({
          inventoryStableId: item.inventoryStableId,
          productName: item.productName,
          productKey: item.productKey,
          pickupDateKey: item.pickupDateKey,
          pickupDateText: item.pickupDateText,
          storageMethod: item.storageMethod,
          imageUrl: item.imageUrl,
          salePrice: item.salePrice,
          quantity: item.quantity,
          customerLabel: body.customerLabel,
          customerDigits4: body.customerDigits4,
          locationMemo: body.locationMemo,
          visitDateText: body.visitDateText,
          requestMemo: body.requestMemo,
          storageGroupId,
          status: 'pending'
        });
        storageEvents.push(result);
      }
    } else if (action === 'storage_request_update') {
      await updateStorageRequestEvents({
        eventIds: Array.isArray(body.eventIds) ? body.eventIds : [body.eventId],
        status: body.status,
        locationMemo: body.locationMemo,
        visitDateText: body.visitDateText,
        requestMemo: body.requestMemo,
        items: body.items
      });
    } else if (action === 'storage_request_pickup_complete') {
      await updateStorageRequestEvents({
        eventIds: Array.isArray(body.eventIds) ? body.eventIds : [body.eventId],
        status: 'picked_up',
        items: body.items
      });
    } else if (action === 'storage_request_complete') {
      const eventIds = Array.isArray(body.eventIds) && body.eventIds.length
        ? body.eventIds
        : [body.eventId].filter(Boolean);

      if (eventIds.length) {
        await updateStorageRequestEvents({
          eventIds,
          status: 'completed',
          locationMemo: body.locationMemo,
          visitDateText: body.visitDateText,
          requestMemo: body.requestMemo,
          items: body.items
        });
      } else {
        const storageGroupId = String(body.storageGroupId || crypto.randomUUID()).trim();
        const items = Array.isArray(body.items) && body.items.length
          ? body.items
          : [{
              inventoryStableId: body.inventoryStableId,
              quantity: body.quantity
            }];

        for (const item of items) {
          const result = await createStorageRequestEvent({
            inventoryStableId: item.inventoryStableId,
            productName: item.productName,
            productKey: item.productKey,
            pickupDateKey: item.pickupDateKey,
            pickupDateText: item.pickupDateText,
            storageMethod: item.storageMethod,
            imageUrl: item.imageUrl,
            salePrice: item.salePrice,
            quantity: item.quantity,
            customerLabel: body.customerLabel,
            customerDigits4: body.customerDigits4,
            locationMemo: body.locationMemo,
            visitDateText: body.visitDateText,
            requestMemo: body.requestMemo,
            storageGroupId,
            status: 'completed'
          });
          storageEvents.push(result);
        }
      }
    } else {
      return res.status(400).json({
        ok: false,
        message: '지원하지 않는 액션입니다.'
      });
    }

    const dashboard = shouldReturnDashboard ? await getOperationsDashboardData() : null;
    return res.status(200).json({
      ok: true,
      events: storageEvents,
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
