import * as async from 'async'
import * as fs from 'fs'
import * as sh from 'shelljs'
import * as tmp from 'tmp'
import test from 'ava'
import { RabbitMQHelper } from './rabbitmq-helpers'

const testNamespace = 'rabbitmq-queue-trig-auth-test'
const rabbitmqNamespace = 'rabbitmq-trig-auth-test'
const queueName = 'hello'
const username = "test-user"
const password = "test-password"
const vhost = "test-vh"
const connectionString = `amqp://${username}:${password}@rabbitmq.${rabbitmqNamespace}.svc.cluster.local/${vhost}`
const messageCount = 500

test.before(t => {
  // install rabbitmq
  RabbitMQHelper.installRabbit(t, username, password, vhost, rabbitmqNamespace)

  sh.config.silent = true

  RabbitMQHelper.createDeployment(t, testNamespace, deployYaml, connectionString, connectionString, queueName)
})

test.serial('Deployment should have 0 replicas on start', t => {
  const replicaCount = sh.exec(
    `kubectl get deployment.apps/test-deployment --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
  ).stdout
  t.is(replicaCount, '0', 'replica count should start out as 0')
})

test.serial(`Deployment should scale to 4 with ${messageCount} messages on the queue then back to 0`, t => {
  RabbitMQHelper.publishMessages(t, testNamespace, connectionString, messageCount, queueName)

  // with messages published, the consumer deployment should start receiving the messages
  let replicaCount = '0'
  for (let i = 0; i < 10 && replicaCount !== '4'; i++) {
    replicaCount = sh.exec(
      `kubectl get deployment.apps/test-deployment --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
    ).stdout
    t.log('replica count is:' + replicaCount)
    if (replicaCount !== '4') {
      sh.exec('sleep 5s')
    }
  }

  t.is('4', replicaCount, 'Replica count should be 4 after 10 seconds')

  for (let i = 0; i < 50 && replicaCount !== '0'; i++) {
    replicaCount = sh.exec(
      `kubectl get deployment.apps/test-deployment --namespace ${testNamespace} -o jsonpath="{.spec.replicas}"`
    ).stdout
    if (replicaCount !== '0') {
      sh.exec('sleep 5s')
    }
  }

  t.is('0', replicaCount, 'Replica count should be 0 after 3 minutes')
})

test.after.always.cb('clean up rabbitmq-queue deployment', t => {
  const resources = [
    'scaledobject.keda.sh/test-scaledobject',
    'triggerauthentications.keda.sh/rabbitmq-trigger-auth',
    'secret/test-secrets',
    'deployment.apps/test-deployment',
  ]

  for (const resource of resources) {
    sh.exec(`kubectl delete ${resource} --namespace ${testNamespace}`)
  }
  sh.exec(`kubectl delete namespace ${testNamespace}`)

  // remove rabbitmq
  RabbitMQHelper.uninstallRabbit(rabbitmqNamespace)
  t.end()
})

const deployYaml = `apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-test-secret
data:
  RabbitMqHost: {{CONNECTION_STRING_BASE64}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
  labels:
    app: test-deployment
spec:
  replicas: 0
  selector:
    matchLabels:
      app: test-deployment
  template:
    metadata:
      labels:
        app: test-deployment
    spec:
      containers:
      - name: rabbitmq-consumer
        image: ghcr.io/kedacore/tests-rabbitmq
        imagePullPolicy: Always
        command:
          - receive
        args:
          - '{{CONNECTION_STRING}}'
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-trigger-auth
spec:
  secretTargetRef:
  - parameter: host
    name: rabbitmq-test-secret
    key: RabbitMqHost
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: test-scaledobject
spec:
  scaleTargetRef:
    name: test-deployment
  pollingInterval: 5
  cooldownPeriod: 10
  minReplicaCount: 0
  maxReplicaCount: 4
  triggers:
  - type: rabbitmq
    metadata:
      queueName: {{QUEUE_NAME}}
      queueLength: '50'
    authenticationRef:
      name: rabbitmq-trigger-auth`
