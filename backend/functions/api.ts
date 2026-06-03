import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface ResourceItem {
  pk: string;
  sk: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: any;
}

const TABLE_CONFIGS = {
  '0': { name: '製品マスタ', pk: 'PRODUCT', fields: ['製品コード', '製品名', '製品分類', '単位', '有効フラグ', '作成者ID', '更新者ID'] },
  '1': { name: '工程マスタ', pk: 'PROCESS', fields: ['工程コード', '工程名', '工程区分', '有効フラグ', '作成者', '更新者'] },
  '2': { name: '生産指示書', pk: 'PRODUCTION_ORDER', fields: ['生産指示書番号', '製品ID', '生産数量', '完成予定日', 'ステータス', '優先度', '作成者'] },
  '3': { name: '生産指示工程', pk: 'PRODUCTION_PROCESS', fields: ['生産指示書ID', '工程ID', '工程順序', '予定開始日時', '予定終了日時', '工程ステータス', '予定作業時間', '作成者ID'] },
  '4': { name: '作業実績', pk: 'WORK_RESULT', fields: ['生産指示工程ID', '作業開始日時', '作業者ID', '作業ステータス', '作成者'] },
  '5': { name: '品質チェック結果', pk: 'QUALITY_CHECK', fields: ['生産指示工程ID', '製品ID', '工程ID', 'チェック項目名', '判定結果', 'チェック数量', '合格数量', '不合格数量', 'チェック実施日時', 'チェック担当者', '作成者'] },
  '6': { name: '工程引継ぎ情報', pk: 'PROCESS_HANDOVER', fields: ['生産指示書ID', '前工程ID', '次工程ID', '引継ぎ数量', '引継ぎ日時', '引継ぎ担当者', '品質状態', '受領確認フラグ', '作成者'] },
  '7': { name: '作業ログ', pk: 'WORK_LOG', fields: ['生産指示工程ID', '作業者ID', '作業開始日時', '作業内容', '作業状態'] },
  '8': { name: '品質問題履歴', pk: 'QUALITY_ISSUE', fields: ['生産指示書ID', '工程ID', '製品ID', '問題分類', '問題内容', '発生数量', '重要度', '発生日時', '発見者', 'ステータス', '作成者', '更新者'] }
};

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayProxyEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'] || 'viewer';
  return validateRole(role);
}

function getUserId(event: APIGatewayProxyEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'anonymous';
}

async function createAuditLog(action: string, resourceType: string, resourceId: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    id: randomUUID(),
    action,
    resourceType,
    resourceId,
    userId,
    details,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let userRole: Role;
    let userId: string;
    
    try {
      userRole = getUserRole(event);
      userId = getUserId(event);
    } catch (error) {
      return createResponse(403, { error: 'Invalid role' });
    }

    // GET /resources - 全リソース一覧
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk <> :auditPk',
          ExpressionAttributeValues: {
            ':auditPk': 'AUDIT'
          }
        }));

        const groupedResources: Record<string, any[]> = {};
        
        for (const item of result.Items || []) {
          const pk = item.pk;
          if (!groupedResources[pk]) {
            groupedResources[pk] = [];
          }
          groupedResources[pk].push(item);
        }

        return createResponse(200, {
          resources: groupedResources,
          count: result.Count || 0
        });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // テーブル別エンドポイント
    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      // 一括インポート POST /api/{tableIndex}/bulk
      if (method === 'POST' && pathSegments[2] === 'bulk') {
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const items = body.items || [];
          
          if (!Array.isArray(items)) {
            return createResponse(400, { error: 'Items must be an array' });
          }

          let imported = 0;
          let failed = 0;
          const errors: string[] = [];
          const now = new Date().toISOString();

          // 25件ずつに分割してバッチ処理
          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            const writeRequests = [];

            for (const item of batch) {
              try {
                const validationErrors = validateRequiredFields(item, config.fields);
                if (validationErrors.length > 0) {
                  errors.push(`Item ${i + batch.indexOf(item)}: ${validationErrors.join(', ')}`);
                  failed++;
                  continue;
                }

                const id = item.id || randomUUID();
                const processedItem: ResourceItem = {
                  pk: config.pk,
                  sk: id,
                  id,
                  ...item,
                  createdAt: item.createdAt || now,
                  updatedAt: now
                };

                writeRequests.push({
                  PutRequest: {
                    Item: processedItem
                  }
                });
              } catch (error) {
                errors.push(`Item ${i + batch.indexOf(item)}: Invalid data format`);
                failed++;
              }
            }

            if (writeRequests.length > 0) {
              try {
                await docClient.send(new BatchWriteCommand({
                  RequestItems: {
                    [TABLE_NAME]: writeRequests
                  }
                }));
                imported += writeRequests.length;
              } catch (error) {
                console.error('Batch write error:', error);
                failed += writeRequests.length;
                errors.push(`Batch write failed: ${error}`);
              }
            }
          }

          await createAuditLog('BULK_IMPORT', config.name, config.pk, userId, { imported, failed, total: items.length });

          return createResponse(200, { imported, failed, errors });
        } catch (error) {
          console.error('Bulk import error:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // 一覧取得 GET /api/{tableIndex}
      if (method === 'GET' && pathSegments.length === 2) {
        if (!hasPermission(userRole, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            }
          }));

          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        } catch (error) {
          console.error('Error fetching items:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // 詳細取得 GET /api/{tableIndex}/{id}
      if (method === 'GET' && pathSegments.length === 3) {
        if (!hasPermission(userRole, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        
        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: id
            }
          }));

          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          return createResponse(200, result.Item);
        } catch (error) {
          console.error('Error fetching item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // 作成 POST /api/{tableIndex}
      if (method === 'POST' && pathSegments.length === 2) {
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const validationErrors = validateRequiredFields(body, config.fields);
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          const id = body.id || randomUUID();
          const now = new Date().toISOString();
          
          const item: ResourceItem = {
            pk: config.pk,
            sk: id,
            id,
            ...body,
            createdAt: now,
            updatedAt: now
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog('CREATE', config.name, id, userId, body);

          return createResponse(201, item);
        } catch (error) {
          console.error('Error creating item:', error);
          if (error instanceof SyntaxError) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // 更新 PUT /api/{tableIndex}/{id}
      if (method === 'PUT' && pathSegments.length === 3) {
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        
        try {
          const body = JSON.parse(event.body || '{}');
          const validationErrors = validateRequiredFields(body, config.fields);
          
          if (validationErrors.length > 0) {
            return createResponse(400, { error: 'Validation failed', details: validationErrors });
          }

          // 既存アイテムの確認
          const existingResult = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: id
            }
          }));

          if (!existingResult.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem: ResourceItem = {
            ...existingResult.Item,
            ...body,
            pk: config.pk,
            sk: id,
            id,
            updatedAt: new Date().toISOString()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog('UPDATE', config.name, id, userId, body);

          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Error updating item:', error);
          if (error instanceof SyntaxError) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // 削除 DELETE /api/{tableIndex}/{id}
      if (method === 'DELETE' && pathSegments.length === 3) {
        if (!hasPermission(userRole, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = pathSegments[2];
        
        try {
          // 既存アイテムの確認
          const existingResult = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: id
            }
          }));

          if (!existingResult.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: id
            }
          }));

          await createAuditLog('DELETE', config.name, id, userId, existingResult.Item);

          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};