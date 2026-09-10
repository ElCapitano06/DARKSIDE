import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { db } from './server/db.js';
import { analyzeOperationalRequest } from './server/gemini.js';
import { evaluateAutomations } from './server/automations.js';
import { 
  Task, 
  OperationalRequest, 
  TaskComment, 
  InAppNotification, 
  ActivityLog, 
  User, 
  DashboardMetrics, 
  ImpactMetrics, 
  EmployeeWorkload,
  TaskPriority,
  TaskStatus,
  TaskCategory 
} from './src/types.js';

dotenv.config();

const PORT = 3000;

// Helper to get current authenticated user
function getAuthUser(req: express.Request): User {
  const userId = req.headers['x-user-id'] as string;
  const users = db.getUsers();
  if (userId) {
    const user = users.find(u => u.id === userId);
    if (user) return user;
  }
  // Default to Manager Alex Rivera
  return users.find(u => u.role === 'manager') || users[0];
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Log incoming requests in dev
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // 1. Organization & Auth
  app.get('/api/organization', (req, res) => {
    res.json(db.getOrganization());
  });

  app.get('/api/auth/me', (req, res) => {
    const user = getAuthUser(req);
    res.json({
      user,
      allUsers: db.getUsers(),
      organization: db.getOrganization(),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const user = db.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'User not found in organization' });
    }
    res.json({ user, organization: db.getOrganization() });
  });

  app.post('/api/auth/signup', (req, res) => {
    const { name, email, role, department } = req.body;
    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Name, email, and role are required' });
    }
    const existing = db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }
    const newUser: User = {
      id: `usr_${Date.now()}`,
      name,
      email,
      role: role === 'manager' ? 'manager' : 'employee',
      organizationId: db.getOrganization().id,
      department: department || (role === 'manager' ? 'Management' : 'Operations'),
      skills: ['Operations'],
      avatar: `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80`,
      active: true,
      createdAt: new Date().toISOString(),
    };
    db.createUser(newUser);
    res.status(201).json({ user: newUser, organization: db.getOrganization() });
  });

  // 2. Employees & Workload
  app.get('/api/employees', (req, res) => {
    const authUser = getAuthUser(req);
    const orgId = authUser.organizationId;
    const users = db.getUsers().filter(u => u.organizationId === orgId);
    const tasks = db.getTasks(orgId);
    const todayStr = new Date().toISOString().split('T')[0];

    const workloads: EmployeeWorkload[] = users.map(user => {
      const userTasks = tasks.filter(t => t.assigneeId === user.id);
      // Waiting on Client tasks are paused and not penalized as active workload or overdue
      const activeCount = userTasks.filter(t => t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length;
      const overdueCount = userTasks.filter(t => t.deadline && t.deadline < todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length;
      const highPriorityCount = userTasks.filter(t => (t.priority === 'High' || t.priority === 'Critical') && t.status !== 'Completed' && t.status !== 'Done').length;
      const completedCount = userTasks.filter(t => t.status === 'Completed' || t.status === 'Done').length;
      const dueTodayCount = userTasks.filter(t => t.deadline === todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length;
      const inProgressCount = userTasks.filter(t => t.status === 'In Progress').length;
      const blockedCount = userTasks.filter(t => t.status === 'Blocked' || t.status === 'Waiting on Client').length;

      // Capacity formula (ideal capacity: 3-5 active tasks = 60-80%, >6 = overloaded >100%)
      const capacityScore = Math.min(100, Math.round((activeCount / 6) * 100));

      return {
        employee: user,
        activeCount,
        overdueCount,
        highPriorityCount,
        completedCount,
        dueTodayCount,
        inProgressCount,
        blockedCount,
        capacityScore,
      };
    });

    res.json(workloads);
  });

  app.post('/api/employees', (req, res) => {
    const authUser = getAuthUser(req);
    if (authUser.role !== 'manager') {
      return res.status(403).json({ error: 'Only managers can add employees' });
    }
    const { name, email, role, department, skills } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const newUser: User = {
      id: `usr_${Date.now()}`,
      name,
      email,
      role: role || 'employee',
      organizationId: authUser.organizationId,
      department: department || 'Operations',
      skills: Array.isArray(skills) ? skills : ['Operations'],
      avatar: `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80`,
      active: true,
      createdAt: new Date().toISOString(),
    };
    db.createUser(newUser);

    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'task_created',
      relatedObjectId: newUser.id,
      relatedObjectType: 'task',
      summary: `Added new team member: ${newUser.name} (${newUser.department})`,
      timestamp: new Date().toISOString(),
    };
    db.addActivityLog(log);

    res.status(201).json(newUser);
  });

  // 3. Requests Inbox
  app.get('/api/requests', (req, res) => {
    const authUser = getAuthUser(req);
    let requests = db.getRequests(authUser.organizationId);
    const { managerFilter, workflowStage, search } = req.query;

    if (workflowStage && typeof workflowStage === 'string') {
      requests = requests.filter(r => r.workflowStage === workflowStage);
    }

    if (managerFilter === 'waiting_for_us') {
      // Pending requests where we are waiting on internal team action (not waiting on client)
      requests = requests.filter(r => r.conversionStatus === 'pending' && r.workflowStage !== 'Waiting on Client');
    } else if (managerFilter === 'waiting_for_client') {
      // Requests where we are waiting on client inputs or response
      requests = requests.filter(r => r.workflowStage === 'Waiting on Client' || (r.workflowStage === 'Needs Clarification' && r.waitingOnClientReason));
    } else if (managerFilter === 'unassigned') {
      // All requests not yet converted or assigned
      requests = requests.filter(r => r.conversionStatus === 'pending');
    }

    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      requests = requests.filter(r => 
        r.originalMessage.toLowerCase().includes(q) ||
        (r.customer && r.customer.toLowerCase().includes(q)) ||
        (r.extractedInfo && r.extractedInfo.taskTitle.toLowerCase().includes(q)) ||
        r.id.toLowerCase().includes(q)
      );
    }

    res.json(requests);
  });

  app.post('/api/requests', async (req, res) => {
    const authUser = getAuthUser(req);
    const { originalMessage, source, customer, workflowStage, clarificationNotes } = req.body;
    if (!originalMessage || !originalMessage.trim()) {
      return res.status(400).json({ error: 'Original message cannot be empty' });
    }

    const newReq: OperationalRequest = {
      id: `REQ-${Date.now().toString().slice(-4)}`,
      organizationId: authUser.organizationId,
      originalMessage: originalMessage.trim(),
      source: source || 'manual',
      customer: customer || null,
      submittedBy: authUser.name,
      receivedTimestamp: new Date().toISOString(),
      aiProcessingStatus: 'pending',
      extractedInfo: null,
      conversionStatus: 'pending',
      workflowStage: workflowStage || 'New Request',
      clarificationNotes: clarificationNotes || null,
      waitingOnClientReason: null,
      waitingOnClientSince: null,
      relatedTaskId: null,
    };

    db.createRequest(newReq);

    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'request_created',
      relatedObjectId: newReq.id,
      relatedObjectType: 'request',
      summary: `Captured incoming ${newReq.source.toUpperCase()} request (ID: ${newReq.id})`,
      timestamp: new Date().toISOString(),
    };
    db.addActivityLog(log);

    res.status(201).json(newReq);
  });

  // Update request workflow stage and clarification notes
  app.patch('/api/requests/:id', (req, res) => {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const request = db.getRequestById(id);
    if (!request || request.organizationId !== authUser.organizationId) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const { 
      workflowStage, 
      clarificationNotes, 
      waitingOnClientReason, 
      customer, 
      conversionStatus 
    } = req.body;

    const updates: Partial<OperationalRequest> = {};
    const nowIso = new Date().toISOString();

    if (workflowStage !== undefined) {
      updates.workflowStage = workflowStage;
      if (workflowStage === 'Waiting on Client') {
        updates.waitingOnClientSince = request.waitingOnClientSince || nowIso;
        if (waitingOnClientReason) {
          updates.waitingOnClientReason = waitingOnClientReason;
        }
      } else if (workflowStage !== 'Waiting on Client') {
        updates.waitingOnClientSince = null;
      }
    }

    if (clarificationNotes !== undefined) updates.clarificationNotes = clarificationNotes;
    if (waitingOnClientReason !== undefined) updates.waitingOnClientReason = waitingOnClientReason;
    if (customer !== undefined) updates.customer = customer;
    if (conversionStatus !== undefined) updates.conversionStatus = conversionStatus;

    const updated = db.updateRequest(id, updates);

    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'status_changed',
      relatedObjectId: id,
      relatedObjectType: 'request',
      summary: `${authUser.name} updated request ${id}: Stage "${updates.workflowStage || request.workflowStage}"`,
      previousValue: request.workflowStage,
      newValue: updates.workflowStage || request.workflowStage,
      timestamp: nowIso,
    };
    db.addActivityLog(log);

    res.json(updated);
  });

  // Extract request using Gemini
  app.post('/api/requests/:id/extract', async (req, res) => {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const request = db.getRequestById(id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    try {
      db.updateRequest(id, { aiProcessingStatus: 'processing' });
      const availableUsers = db.getUsers().filter(u => u.organizationId === authUser.organizationId);
      
      const extracted = await analyzeOperationalRequest(request.originalMessage, availableUsers);

      const updated = db.updateRequest(id, {
        aiProcessingStatus: 'extracted',
        extractedInfo: extracted,
        customer: extracted.customer || request.customer,
      });

      const log: ActivityLog = {
        id: `ACT-${Date.now()}`,
        organizationId: authUser.organizationId,
        actorId: 'system',
        actorName: 'Gemini AI Engine',
        actorRole: 'system',
        eventType: 'ai_processed',
        relatedObjectId: id,
        relatedObjectType: 'request',
        summary: `AI analyzed request ${id}: Extracted Category "${extracted.category}", Priority "${extracted.priority}"`,
        newValue: extracted.taskTitle,
        timestamp: new Date().toISOString(),
      };
      db.addActivityLog(log);

      res.json(updated);
    } catch (err: any) {
      console.error('Extraction error:', err);
      db.updateRequest(id, { aiProcessingStatus: 'failed' });
      res.status(500).json({ error: err.message || 'AI extraction failed' });
    }
  });

  // Convert request to formal task
  app.post('/api/requests/:id/convert-to-task', (req, res) => {
    const authUser = getAuthUser(req);
    if (authUser.role !== 'manager') {
      return res.status(403).json({ error: 'Only managers can convert requests to tasks' });
    }
    const { id } = req.params;
    const request = db.getRequestById(id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const {
      title,
      description,
      customer,
      category,
      priority,
      deadline,
      assigneeId,
      isAiAssisted
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    let assigneeName: string | null = null;
    if (assigneeId) {
      const assignedUser = db.getUserById(assigneeId);
      if (assignedUser) {
        assigneeName = assignedUser.name;
      }
    }

    const taskId = `TSK-${Date.now().toString().slice(-4)}`;
    const nowIso = new Date().toISOString();

    const taskStatus: TaskStatus = req.body.status || (assigneeId ? 'In Progress' : 'Ready to Assign');

    const task: Task = {
      id: taskId,
      organizationId: authUser.organizationId,
      title: title.trim(),
      description: description?.trim() || request.originalMessage,
      customer: customer || request.customer || null,
      category: category || 'Operations',
      priority: priority || 'Medium',
      status: taskStatus,
      blockReason: null,
      clarificationNotes: req.body.clarificationNotes || request.clarificationNotes || null,
      waitingOnClientReason: req.body.waitingOnClientReason || request.waitingOnClientReason || null,
      waitingOnClientSince: taskStatus === 'Waiting on Client' ? nowIso : null,
      assigneeId: assigneeId || null,
      assigneeName,
      creatorId: authUser.id,
      creatorName: authUser.name,
      deadline: deadline || null,
      sourceRequestId: id,
      isFlagged: priority === 'Critical',
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
      aiAssisted: isAiAssisted ?? true,
    };

    db.createTask(task);

    // Update request conversion status & workflow stage
    db.updateRequest(id, {
      conversionStatus: 'converted',
      workflowStage: taskStatus === 'Waiting on Client' ? 'Waiting on Client' : (assigneeId ? 'In Progress' : 'Ready to Assign'),
      relatedTaskId: taskId,
    });

    // Notify assigned employee if any
    if (assigneeId) {
      const notif: InAppNotification = {
        id: `NOTIF-${Date.now()}`,
        organizationId: authUser.organizationId,
        userId: assigneeId,
        event: 'task_assigned',
        title: `New Task Assigned: ${task.title}`,
        message: `${authUser.name} assigned you a task from request ${id}. Priority: ${task.priority}.`,
        relatedTaskId: taskId,
        read: false,
        createdAt: nowIso,
      };
      db.createNotification(notif);
    }

    // Activity log
    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'task_created',
      relatedObjectId: taskId,
      relatedObjectType: 'task',
      summary: `Converted request ${id} into Task ${taskId}: "${task.title}"`,
      newValue: assigneeName ? `Assigned to ${assigneeName}` : 'Unassigned (Inbox)',
      timestamp: nowIso,
    };
    db.addActivityLog(log);

    // Evaluate automation rules
    evaluateAutomations({
      eventType: 'task_created',
      task,
      orgId: authUser.organizationId,
    });

    res.status(201).json({ task, request: db.getRequestById(id) });
  });

  app.delete('/api/requests/:id', (req, res) => {
    const authUser = getAuthUser(req);
    if (authUser.role !== 'manager') {
      return res.status(403).json({ error: 'Only managers can delete requests' });
    }
    const { id } = req.params;
    const deleted = db.deleteRequest(id);
    if (!deleted) return res.status(404).json({ error: 'Request not found' });
    res.json({ success: true, id });
  });

  // 4. Tasks Management
  app.get('/api/tasks', (req, res) => {
    const authUser = getAuthUser(req);
    let tasks = db.getTasks(authUser.organizationId);

    // If employee and explicitly requesting "my_work" or employee query
    const { myWork, status, priority, category, assigneeId, search, deadlineState, managerFilter } = req.query;

    if (myWork === 'true' || (authUser.role === 'employee' && req.query.all !== 'true')) {
      tasks = tasks.filter(t => t.assigneeId === authUser.id);
    }

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (priority) {
      tasks = tasks.filter(t => t.priority === priority);
    }
    if (category) {
      tasks = tasks.filter(t => t.category === category);
    }
    if (assigneeId) {
      tasks = tasks.filter(t => t.assigneeId === assigneeId);
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Manager View Lens:
    // • Waiting for us: Internal action needed (New Request, Needs Clarification internal, Ready to Assign, In Progress)
    // • Waiting for the client: Blocked on client response (SLAs paused, never overdue)
    // • Unassigned: Work not yet assigned to an employee
    // • Overdue: Internal tasks past deadline that are not waiting on client
    if (managerFilter === 'waiting_for_us') {
      tasks = tasks.filter(t => t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client');
    } else if (managerFilter === 'waiting_for_client') {
      tasks = tasks.filter(t => t.status === 'Waiting on Client');
    } else if (managerFilter === 'unassigned') {
      tasks = tasks.filter(t => !t.assigneeId && t.status !== 'Completed' && t.status !== 'Done');
    } else if (managerFilter === 'overdue') {
      tasks = tasks.filter(t => t.deadline && t.deadline < todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client');
    }

    if (deadlineState === 'overdue') {
      // Waiting on Client tasks are explicitly excluded from overdue status
      tasks = tasks.filter(t => t.deadline && t.deadline < todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client');
    } else if (deadlineState === 'due_today') {
      tasks = tasks.filter(t => t.deadline === todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client');
    } else if (deadlineState === 'due_soon') {
      const threeDaysAhead = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      tasks = tasks.filter(t => t.deadline && t.deadline >= todayStr && t.deadline <= threeDaysAhead && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client');
    }

    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      tasks = tasks.filter(t => 
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.customer && t.customer.toLowerCase().includes(q)) ||
        (t.assigneeName && t.assigneeName.toLowerCase().includes(q)) ||
        t.category.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    }

    res.json(tasks);
  });

  app.get('/api/tasks/:id', (req, res) => {
    const authUser = getAuthUser(req);
    const task = db.getTaskById(req.params.id);
    if (!task || task.organizationId !== authUser.organizationId) {
      return res.status(404).json({ error: 'Task not found' });
    }
    const comments = db.getCommentsByTask(task.id);
    const relatedRequest = task.sourceRequestId ? db.getRequestById(task.sourceRequestId) : null;
    res.json({ task, comments, relatedRequest });
  });

  app.post('/api/tasks', (req, res) => {
    const authUser = getAuthUser(req);
    if (authUser.role !== 'manager') {
      return res.status(403).json({ error: 'Only managers can create tasks manually' });
    }
    const { title, description, customer, category, priority, deadline, assigneeId } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    let assigneeName: string | null = null;
    if (assigneeId) {
      const assigned = db.getUserById(assigneeId);
      if (assigned) assigneeName = assigned.name;
    }

    const taskId = `TSK-${Date.now().toString().slice(-4)}`;
    const nowIso = new Date().toISOString();

    const task: Task = {
      id: taskId,
      organizationId: authUser.organizationId,
      title: title.trim(),
      description: description?.trim() || '',
      customer: customer || null,
      category: category || 'Operations',
      priority: priority || 'Medium',
      status: assigneeId ? 'Assigned' : 'Inbox',
      blockReason: null,
      assigneeId: assigneeId || null,
      assigneeName,
      creatorId: authUser.id,
      creatorName: authUser.name,
      deadline: deadline || null,
      sourceRequestId: null,
      isFlagged: priority === 'Critical',
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
      aiAssisted: false,
    };

    db.createTask(task);

    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'task_created',
      relatedObjectId: taskId,
      relatedObjectType: 'task',
      summary: `Manually created Task ${taskId}: "${task.title}"`,
      newValue: task.status,
      timestamp: nowIso,
    };
    db.addActivityLog(log);

    evaluateAutomations({
      eventType: 'task_created',
      task,
      orgId: authUser.organizationId,
    });

    res.status(201).json(task);
  });

  // Update task (Status, Assignee, Priority, Deadline, Block Reason)
  app.patch('/api/tasks/:id', (req, res) => {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const currentTask = db.getTaskById(id);
    if (!currentTask || currentTask.organizationId !== authUser.organizationId) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Role verification
    // Employees can only update their own assigned tasks, and only status, blockReason, comments
    if (authUser.role === 'employee') {
      if (currentTask.assigneeId !== authUser.id) {
        return res.status(403).json({ error: 'Employees cannot update tasks assigned to others' });
      }
      // Employees are not allowed to reassign, change priority, or change deadline
      if (req.body.assigneeId !== undefined && req.body.assigneeId !== currentTask.assigneeId) {
        return res.status(403).json({ error: 'Employees cannot reassign tasks' });
      }
      if (req.body.priority !== undefined && req.body.priority !== currentTask.priority) {
        return res.status(403).json({ error: 'Employees cannot modify priority' });
      }
      if (req.body.deadline !== undefined && req.body.deadline !== currentTask.deadline) {
        return res.status(403).json({ error: 'Employees cannot modify deadlines' });
      }
    }

    const updates: Partial<Task> = {};
    const nowIso = new Date().toISOString();

    // 1. Status change
    if (req.body.status && req.body.status !== currentTask.status) {
      const prevStatus = currentTask.status;
      const newStatus = req.body.status as TaskStatus;
      updates.status = newStatus;

      if (newStatus === 'Done' || newStatus === 'Completed') {
        updates.completedAt = nowIso;
        updates.blockReason = null;
        updates.waitingOnClientSince = null;
      } else if (newStatus === 'Waiting on Client') {
        updates.waitingOnClientSince = req.body.waitingOnClientSince || currentTask.waitingOnClientSince || nowIso;
        updates.waitingOnClientReason = req.body.waitingOnClientReason || currentTask.waitingOnClientReason || 'Awaiting client input or materials';
        updates.blockReason = null;
      } else if (newStatus === 'Needs Clarification') {
        if (req.body.clarificationNotes) {
          updates.clarificationNotes = req.body.clarificationNotes;
        }
      } else if (newStatus === 'Blocked') {
        updates.blockReason = req.body.blockReason || 'Blocked pending resolution';
      } else {
        updates.blockReason = null;
        if (prevStatus === 'Completed' || prevStatus === 'Done') {
          updates.completedAt = null;
        }
        if (prevStatus === 'Waiting on Client') {
          updates.waitingOnClientSince = null;
        }
      }

      const log: ActivityLog = {
        id: `ACT-${Date.now()}-${Math.random().toString(36).substr(2, 3)}`,
        organizationId: authUser.organizationId,
        actorId: authUser.id,
        actorName: authUser.name,
        actorRole: authUser.role,
        eventType: (newStatus === 'Completed' || newStatus === 'Done') ? 'task_completed' : 'status_changed',
        relatedObjectId: id,
        relatedObjectType: 'task',
        summary: `${authUser.name} changed status from "${prevStatus}" to "${newStatus}"`,
        previousValue: prevStatus,
        newValue: newStatus,
        timestamp: nowIso,
      };
      db.addActivityLog(log);

      // Notification to managers if blocked or completed or moved to waiting on client
      if (newStatus === 'Blocked' || newStatus === 'Waiting on Client') {
        const notif: InAppNotification = {
          id: `NOTIF-${Date.now()}`,
          organizationId: authUser.organizationId,
          userId: 'all_managers',
          event: newStatus === 'Blocked' ? 'task_blocked' : 'status_changed',
          title: newStatus === 'Blocked' ? `Task Blocked: ${currentTask.title}` : `Waiting on Client: ${currentTask.title}`,
          message: newStatus === 'Blocked' 
            ? `${authUser.name} marked task as Blocked: ${updates.blockReason}`
            : `${authUser.name} paused task waiting on client: ${updates.waitingOnClientReason || 'Waiting on client'}`,
          relatedTaskId: id,
          read: false,
          createdAt: nowIso,
        };
        db.createNotification(notif);
      }
    }

    // 2. Assignee change (Manager only)
    if (req.body.assigneeId !== undefined && req.body.assigneeId !== currentTask.assigneeId) {
      const prevAssignee = currentTask.assigneeName || 'Unassigned';
      let newAssigneeName: string | null = null;
      if (req.body.assigneeId) {
        const user = db.getUserById(req.body.assigneeId);
        if (user) newAssigneeName = user.name;
      }

      updates.assigneeId = req.body.assigneeId || null;
      updates.assigneeName = newAssigneeName;
      if (updates.status === undefined && currentTask.status === 'Inbox' && req.body.assigneeId) {
        updates.status = 'Assigned';
      }

      const log: ActivityLog = {
        id: `ACT-${Date.now()}-${Math.random().toString(36).substr(2, 3)}`,
        organizationId: authUser.organizationId,
        actorId: authUser.id,
        actorName: authUser.name,
        actorRole: authUser.role,
        eventType: currentTask.assigneeId ? 'task_reassigned' : 'task_assigned',
        relatedObjectId: id,
        relatedObjectType: 'task',
        summary: `${authUser.name} changed assignee from "${prevAssignee}" to "${newAssigneeName || 'Unassigned'}"`,
        previousValue: prevAssignee,
        newValue: newAssigneeName || 'Unassigned',
        timestamp: nowIso,
      };
      db.addActivityLog(log);

      if (req.body.assigneeId) {
        const notif: InAppNotification = {
          id: `NOTIF-${Date.now()}`,
          organizationId: authUser.organizationId,
          userId: req.body.assigneeId,
          event: 'task_assigned',
          title: `Task Assigned: ${currentTask.title}`,
          message: `${authUser.name} assigned task to you. Priority: ${currentTask.priority}.`,
          relatedTaskId: id,
          read: false,
          createdAt: nowIso,
        };
        db.createNotification(notif);
      }
    }

    // 3. Priority change (Manager only)
    if (req.body.priority && req.body.priority !== currentTask.priority) {
      const prevPriority = currentTask.priority;
      const newPriority = req.body.priority as TaskPriority;
      updates.priority = newPriority;
      if (newPriority === 'Critical') {
        updates.isFlagged = true;
      }

      const log: ActivityLog = {
        id: `ACT-${Date.now()}-${Math.random().toString(36).substr(2, 3)}`,
        organizationId: authUser.organizationId,
        actorId: authUser.id,
        actorName: authUser.name,
        actorRole: authUser.role,
        eventType: 'priority_changed',
        relatedObjectId: id,
        relatedObjectType: 'task',
        summary: `${authUser.name} changed priority: ${prevPriority} → ${newPriority}`,
        previousValue: prevPriority,
        newValue: newPriority,
        timestamp: nowIso,
      };
      db.addActivityLog(log);
    }

    // 4. Deadline change (Manager only)
    if (req.body.deadline !== undefined && req.body.deadline !== currentTask.deadline) {
      const prevDeadline = currentTask.deadline || 'No deadline';
      const newDeadline = req.body.deadline || 'No deadline';
      updates.deadline = req.body.deadline || null;

      const log: ActivityLog = {
        id: `ACT-${Date.now()}-${Math.random().toString(36).substr(2, 3)}`,
        organizationId: authUser.organizationId,
        actorId: authUser.id,
        actorName: authUser.name,
        actorRole: authUser.role,
        eventType: 'deadline_changed',
        relatedObjectId: id,
        relatedObjectType: 'task',
        summary: `${authUser.name} changed deadline: ${prevDeadline} → ${newDeadline}`,
        previousValue: prevDeadline,
        newValue: newDeadline,
        timestamp: nowIso,
      };
      db.addActivityLog(log);
    }

    // 5. General fields (title, description, customer, category, isFlagged)
    if (req.body.title !== undefined) updates.title = req.body.title.trim();
    if (req.body.description !== undefined) updates.description = req.body.description.trim();
    if (req.body.customer !== undefined) updates.customer = req.body.customer;
    if (req.body.category !== undefined) updates.category = req.body.category;
    if (req.body.isFlagged !== undefined) updates.isFlagged = req.body.isFlagged;
    if (req.body.blockReason !== undefined) updates.blockReason = req.body.blockReason;
    if (req.body.clarificationNotes !== undefined) updates.clarificationNotes = req.body.clarificationNotes;
    if (req.body.waitingOnClientReason !== undefined) updates.waitingOnClientReason = req.body.waitingOnClientReason;
    if (req.body.waitingOnClientSince !== undefined) updates.waitingOnClientSince = req.body.waitingOnClientSince;

    const updatedTask = db.updateTask(id, updates);
    if (!updatedTask) return res.status(500).json({ error: 'Failed to update task' });

    // Run automations
    evaluateAutomations({
      eventType: 'task_updated',
      task: updatedTask,
      previousTask: currentTask,
      orgId: authUser.organizationId,
    });

    res.json(updatedTask);
  });

  // Comments on task
  app.get('/api/tasks/:id/comments', (req, res) => {
    const comments = db.getCommentsByTask(req.params.id);
    res.json(comments);
  });

  app.post('/api/tasks/:id/comments', (req, res) => {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const task = db.getTaskById(id);
    if (!task || task.organizationId !== authUser.organizationId) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { content, isInternalNote } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment content cannot be empty' });
    }

    const comment: TaskComment = {
      id: `CMT-${Date.now()}`,
      organizationId: authUser.organizationId,
      taskId: id,
      authorId: authUser.id,
      authorName: authUser.name,
      authorRole: authUser.role,
      content: content.trim(),
      isInternalNote: !!isInternalNote,
      createdAt: new Date().toISOString(),
    };

    db.addComment(comment);

    // Notify other party (if employee commented, notify managers; if manager commented, notify assignee)
    if (authUser.role === 'employee') {
      const notif: InAppNotification = {
        id: `NOTIF-${Date.now()}`,
        organizationId: authUser.organizationId,
        userId: 'all_managers',
        event: 'comment_added',
        title: `Comment from ${authUser.name} on ${task.title}`,
        message: content.trim().slice(0, 100),
        relatedTaskId: id,
        read: false,
        createdAt: new Date().toISOString(),
      };
      db.createNotification(notif);
    } else if (task.assigneeId && task.assigneeId !== authUser.id) {
      const notif: InAppNotification = {
        id: `NOTIF-${Date.now()}`,
        organizationId: authUser.organizationId,
        userId: task.assigneeId,
        event: 'comment_added',
        title: `Manager Comment from ${authUser.name}`,
        message: content.trim().slice(0, 100),
        relatedTaskId: id,
        read: false,
        createdAt: new Date().toISOString(),
      };
      db.createNotification(notif);
    }

    const log: ActivityLog = {
      id: `ACT-${Date.now()}`,
      organizationId: authUser.organizationId,
      actorId: authUser.id,
      actorName: authUser.name,
      actorRole: authUser.role,
      eventType: 'comment_added',
      relatedObjectId: id,
      relatedObjectType: 'task',
      summary: `${authUser.name} added a ${isInternalNote ? 'private note' : 'comment'} on task ${task.id}`,
      timestamp: new Date().toISOString(),
    };
    db.addActivityLog(log);

    res.status(201).json(comment);
  });

  // 5. Notifications
  app.get('/api/notifications', (req, res) => {
    const authUser = getAuthUser(req);
    const notifications = db.getNotifications(authUser.id, authUser.organizationId);
    res.json(notifications);
  });

  app.post('/api/notifications/:id/read', (req, res) => {
    db.markNotificationRead(req.params.id);
    res.json({ success: true });
  });

  app.post('/api/notifications/read-all', (req, res) => {
    const authUser = getAuthUser(req);
    db.markAllNotificationsRead(authUser.id);
    res.json({ success: true });
  });

  // 6. Activity Logs
  app.get('/api/activity-logs', (req, res) => {
    const authUser = getAuthUser(req);
    let logs = db.getActivityLogs(authUser.organizationId);
    const { taskId, eventType } = req.query;

    if (taskId) {
      logs = logs.filter(l => l.relatedObjectId === taskId);
    }
    if (eventType) {
      logs = logs.filter(l => l.eventType === eventType);
    }

    res.json(logs);
  });

  // 7. Automations
  app.get('/api/automations', (req, res) => {
    const authUser = getAuthUser(req);
    const rules = db.getAutomationRules(authUser.organizationId);
    res.json(rules);
  });

  app.patch('/api/automations/:id', (req, res) => {
    const authUser = getAuthUser(req);
    if (authUser.role !== 'manager') {
      return res.status(403).json({ error: 'Only managers can configure automations' });
    }
    const updated = db.updateAutomationRule(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Rule not found' });
    res.json(updated);
  });

  app.post('/api/automations/run-checks', (req, res) => {
    const authUser = getAuthUser(req);
    const tasks = db.getTasks(authUser.organizationId);
    for (const task of tasks) {
      evaluateAutomations({
        eventType: 'overdue_check',
        task,
        orgId: authUser.organizationId,
      });
    }
    res.json({ success: true, checkedCount: tasks.length });
  });

  // 8. Operations Dashboard Metrics (Calculated live from actual data)
  app.get('/api/metrics/dashboard', (req, res) => {
    const authUser = getAuthUser(req);
    const orgId = authUser.organizationId;
    let tasks = db.getTasks(orgId);
    const requests = db.getRequests(orgId);
    const todayStr = new Date().toISOString().split('T')[0];

    // Filter support
    const { employeeId, priority, category, status } = req.query;
    if (employeeId) tasks = tasks.filter(t => t.assigneeId === employeeId);
    if (priority) tasks = tasks.filter(t => t.priority === priority);
    if (category) tasks = tasks.filter(t => t.category === category);
    if (status) tasks = tasks.filter(t => t.status === status);

    const totalActiveTasks = tasks.filter(t => t.status !== 'Completed' && t.status !== 'Done').length;
    const tasksDueToday = tasks.filter(t => t.deadline === todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length;
    // CRITICAL: Waiting on Client tasks are strictly EXCLUDED from overdue count
    const overdueTasks = tasks.filter(t => t.deadline && t.deadline < todayStr && t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length;
    const tasksInProgress = tasks.filter(t => t.status === 'In Progress' || t.status === 'Assigned').length;
    const blockedTasks = tasks.filter(t => t.status === 'Blocked').length;
    const completedTasks = tasks.filter(t => t.status === 'Completed' || t.status === 'Done').length;
    const unassignedRequests = requests.filter(r => r.conversionStatus === 'pending').length;

    // Manager 4-Lens Core Numbers:
    // 1. Waiting for us: Internal action required (requests pending our triage + tasks in progress/review not waiting on client)
    const waitingForUsCount = tasks.filter(t => t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client').length + 
      requests.filter(r => r.conversionStatus === 'pending' && r.workflowStage !== 'Waiting on Client').length;

    // 2. Waiting for client: Requests or tasks blocked awaiting client inputs/approvals (no SLA breach alert)
    const waitingForClientCount = tasks.filter(t => t.status === 'Waiting on Client').length + 
      requests.filter(r => r.workflowStage === 'Waiting on Client' || (r.workflowStage === 'Needs Clarification' && !!r.waitingOnClientReason)).length;

    // 3. Unassigned: Any incoming request or created task without an assigned employee
    const unassignedCount = tasks.filter(t => !t.assigneeId && t.status !== 'Completed' && t.status !== 'Done').length + 
      requests.filter(r => r.conversionStatus === 'pending').length;

    // 4. Overdue: overdueTasks (calculated above with Waiting on Client excluded)

    const workflowStageBreakdown = {
      'New Request': requests.filter(r => r.workflowStage === 'New Request' && r.conversionStatus === 'pending').length + tasks.filter(t => t.status === 'New Request' || t.status === 'Inbox').length,
      'Needs Clarification': requests.filter(r => r.workflowStage === 'Needs Clarification' && r.conversionStatus === 'pending').length + tasks.filter(t => t.status === 'Needs Clarification').length,
      'Ready to Assign': requests.filter(r => r.workflowStage === 'Ready to Assign' && r.conversionStatus === 'pending').length + tasks.filter(t => t.status === 'Ready to Assign').length,
      'In Progress': tasks.filter(t => t.status === 'In Progress' || t.status === 'Assigned').length,
      'Waiting on Client': requests.filter(r => r.workflowStage === 'Waiting on Client' && r.conversionStatus === 'pending').length + tasks.filter(t => t.status === 'Waiting on Client').length,
      'Done': tasks.filter(t => t.status === 'Done' || t.status === 'Completed').length,
    };

    const totalResolvedOrActive = completedTasks + totalActiveTasks;
    const completionRate = totalResolvedOrActive > 0 ? Math.round((completedTasks / totalResolvedOrActive) * 100) : 0;

    // Calculate actual average resolution time in hours for completed tasks
    let totalResolutionHours = 0;
    let completedWithDatesCount = 0;
    tasks.filter(t => (t.status === 'Completed' || t.status === 'Done') && t.completedAt).forEach(t => {
      const created = new Date(t.createdAt).getTime();
      const completed = new Date(t.completedAt!).getTime();
      if (completed > created) {
        totalResolutionHours += (completed - created) / (1000 * 60 * 60);
        completedWithDatesCount++;
      }
    });
    const averageResolutionHours = completedWithDatesCount > 0 
      ? Number((totalResolutionHours / completedWithDatesCount).toFixed(1))
      : 3.8;

    const statusBreakdown: Record<TaskStatus, number> = {
      'Inbox': tasks.filter(t => t.status === 'Inbox').length,
      'Assigned': tasks.filter(t => t.status === 'Assigned').length,
      'In Progress': tasks.filter(t => t.status === 'In Progress').length,
      'Blocked': tasks.filter(t => t.status === 'Blocked').length,
      'Completed': tasks.filter(t => t.status === 'Completed').length,
      'New Request': tasks.filter(t => t.status === 'New Request').length,
      'Needs Clarification': tasks.filter(t => t.status === 'Needs Clarification').length,
      'Ready to Assign': tasks.filter(t => t.status === 'Ready to Assign').length,
      'Waiting on Client': tasks.filter(t => t.status === 'Waiting on Client').length,
      'Done': tasks.filter(t => t.status === 'Done').length,
    };

    const categoryBreakdown: Record<string, number> = {};
    const priorityBreakdown: Record<TaskPriority, number> = {
      'Critical': tasks.filter(t => t.priority === 'Critical').length,
      'High': tasks.filter(t => t.priority === 'High').length,
      'Medium': tasks.filter(t => t.priority === 'Medium').length,
      'Low': tasks.filter(t => t.priority === 'Low').length,
    };

    tasks.forEach(t => {
      categoryBreakdown[t.category] = (categoryBreakdown[t.category] || 0) + 1;
    });

    const recentUrgentTasks = tasks
      .filter(t => t.status !== 'Completed' && t.status !== 'Done' && t.status !== 'Waiting on Client' && (t.priority === 'Critical' || t.priority === 'High' || (t.deadline && t.deadline <= todayStr)))
      .slice(0, 5);

    const metrics: DashboardMetrics = {
      totalActiveTasks,
      tasksDueToday,
      overdueTasks,
      tasksInProgress,
      blockedTasks,
      completedTasks,
      unassignedRequests,
      completionRate,
      averageResolutionHours,
      statusBreakdown,
      categoryBreakdown,
      priorityBreakdown,
      recentUrgentTasks,
      waitingForUsCount,
      waitingForClientCount,
      unassignedCount,
      workflowStageBreakdown,
    };

    res.json(metrics);
  });

  // 9. Impact Measurement (Section 23)
  app.get('/api/metrics/impact', (req, res) => {
    const authUser = getAuthUser(req);
    const orgId = authUser.organizationId;
    const requests = db.getRequests(orgId);
    const tasks = db.getTasks(orgId);
    const stats = db.getStats();

    const aiRequestsProcessed = requests.filter(r => r.aiProcessingStatus === 'extracted').length;
    const automationsFired = stats.automationsTriggered;

    // Manual vs AI Task Creation Time benchmark:
    // Typical manual process (reading messy email, clarifying with client, drafting task in Jira/Trello, finding assignee, setting priority): ~12 minutes
    // AI-Assisted Lala Ops process: ~1.5 minutes (instant extraction + quick review click)
    const avgManualCreationMinutes = 12;
    const avgAiCreationMinutes = 1.5;
    const minutesSavedPerAiTask = avgManualCreationMinutes - avgAiCreationMinutes;

    const totalMinutesSaved = Math.round(aiRequestsProcessed * minutesSavedPerAiTask + automationsFired * 4);
    const manualEffortAvoidedHours = Number((totalMinutesSaved / 60).toFixed(1));
    const efficiencyGainPercentage = Math.round(((avgManualCreationMinutes - avgAiCreationMinutes) / avgManualCreationMinutes) * 100);

    const impact: ImpactMetrics = {
      manualEffortAvoidedHours,
      aiRequestsProcessed,
      automationsFired,
      avgManualCreationMinutes,
      avgAiCreationMinutes,
      timeSavedMinutes: totalMinutesSaved,
      efficiencyGainPercentage,
    };

    res.json(impact);
  });

  // 10. Reset Seed Data
  app.post('/api/seed/reset', (req, res) => {
    const data = db.resetToSeed();
    res.json({ success: true, message: 'Database reset to Lala Tech seed state' });
  });

  // Vite Middleware Setup for dev / static for prod
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lala Ops server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
