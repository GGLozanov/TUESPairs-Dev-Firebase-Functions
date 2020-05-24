const functions = require('firebase-functions'); // get the Firebase Cloud Function API
const admin = require('firebase-admin'); // get the admin from the Firebase Admin SDK

admin.initializeApp(functions.config().functions); // config for functions (cloud presumably)

var messageData;

async function sendValidTokens(userId, userDeviceTokens, payload) {
    return admin.messaging().sendToDevice(userDeviceTokens, payload).then(async response => {
        // check the response of the notification sending to all tokens here and validate them
        // removing the invalid ones from the document of the toId user from Firestore
        response.results.forEach((result, index) => { // cleanup the invalid tokens here
            const error = result.error; // get whether there was an error w/ the token sending
            if(error) {
                console.error('Failure sending notification to ', userDeviceTokens[index], error);
                // we know there's an error, which means we have to remove it from the tokens array
                if(error.code === 'messaging/invalid-registration-token' ||
                    error.code === 'messaging/registration-token-not-registered') {
                        userDeviceTokens.splice(index, 1); // remove the token at the index
                }
            }
        });

        return admin.firestore().collection('users')
            .doc(userId)
            .update({ deviceTokens: userDeviceTokens }).then(res => res); // overwrite the token array with the modified device token array
    });
}

async function getUserDataById(userId) {
    var matchedUserDocumentSnapshot = admin.firestore().collection('users').doc(userId).get().then((doc) => {
        if(doc.exists) {
            return doc;  
        }
        console.error('Cannot find user to send the notification to! Their data is null or they do not exist!'); 
        return null;  
    });

    if(matchedUserDocumentSnapshot === null) { // return if doc is null
        return null;
    }

    return (await matchedUserDocumentSnapshot).data();
}

// use the onCreate listener to trigger changes when a new doc is created
exports.messageTrigger = functions.firestore.document('messages/{messageId}').onCreate(async (snapshot, context) => {
    if(snapshot.empty) {
        console.error('No devices found/message data is null!');
        return;
    }

    messageData = snapshot.data(); // get message data for access to the newly created message

    const content = messageData.content; // content of sent message

    const toUserId = messageData.toId;
    const fromUserId = messageData.fromId;

    var toUserData = await getUserDataById(toUserId); // get their data for notification sending
    var fromUserData = await getUserDataById(fromUserId); // get their data for username display

    // Handle errors/invalid info
    if(toUserData === null || fromUserData === null) {
        console.error('One of the users has invalid info! Cancelling notification!');
        return;
    }

    // Notifications in DB only need user id and not anything else (hooray, no complicated deviceToken stuff!) and have no need for hard mobile implementation
    const currentTime = new Date();

    var notificationAddResult = await admin.firestore().collection('notifications').add({ 
        userID: toUserId,
        message: `You've received a new message from ${fromUserData.username}`,
        sentTime: currentTime.toISOString() // convert time
    }); // add the db notification object

    var toUserDeviceTokens = toUserData.deviceTokens; // get the user's original device tokens where he's logged in

    if(toUserDeviceTokens.length === 0) {
        // null/empty array (user logged out from all devices); cancel notification in that case
        console.error('No registered device tokens (user is logged out from all devices). Cancelling notification!');
        return;
    }

    // Send notification if everything's clear
    var payload = { // payload to send as a notification in the specific format required
        notification: { title: 'New message from ' + fromUserData.username + '!', 
            body: 'Message: ' + content ? 
                (content <= 100 ? content : (content.substring(0, 97) + '...')) 
                : '', 
            sound: 'default' 
        },
        data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'You\'ve received a new message!' },
    }

    var tokenMergeResult = await sendValidTokens(
        toUserId, 
        toUserDeviceTokens, 
        payload
    ); // send push notification
});

exports.matchTrigger = functions.firestore.document('users/{userId}').onUpdate(async (snapshot, context) => {
    if(snapshot.before.empty || snapshot.after.empty) {
        console.error('Received empty user snapshot! Cancelling notification.');
        return;
    }

    var userDataBefore = snapshot.before.data();
    var userDataAfter = snapshot.after.data();

    var matchedUserIdBefore = userDataBefore.matchedUserID; // stored in the database as 'ID'
    var matchedUserIdAfter = userDataAfter.matchedUserID; // took me 40 goddamn minutes to find I'd written it as 'Id', smh

    // check from null to id
    // check from id to null

    // TODO: Fix overhead of function call here somehow
    // Firestore still doesn't support individual field change listening
    // but if it comes out, implement it here
    if(matchedUserIdBefore === matchedUserIdAfter) { 
        console.log('No change in matchedUserId detected. Cancelling notification.');
        return; // TODO: Make custom status code to differentiate these function with
    } // check for update in the matchedUserId field and skip otherwise

    // decide whether the current update is a match request or a match clear
    const isMatchRequest = matchedUserIdBefore === null && matchedUserIdAfter !== null; 

    var payload; // payload of notification to send through the FCM as a notification
    var matchedUserData; // matched user doc data (if cleared -> use before Id; if matched -> use after Id)
    var matchedUserDeviceTokens;
    var dbNotificationBody; // body for the database notification

    const currentTime = new Date();
    const sentTime = currentTime.toISOString(); // might have slight inaccuracies due to being called this early

    if(isMatchRequest) {
        // new match request sent
        matchedUserData = await getUserDataById(matchedUserIdAfter);

        if(matchedUserData === null) {
            return; // error handled by getUserData function; no need to log it
        }

        // check whether the users were just matched together or if a match request was sent
        payload = matchedUserData.matchedUserID === snapshot.after.id ? { // payload to send as a notification in the specific format required
            notification: { 
                title: 'Match request accepted by ' + userDataAfter.username + '!',
                body: userDataAfter.username + ' has sent a match request to you! Go see it!',
                sound: 'default' 
            },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'You\'ve received a new match request!' },
        } : {
            notification: { 
                title: 'New match request from ' + userDataAfter.username + '!',
                body: userDataAfter.username + ' has accepted your match request! Go send your first messages!',
                sound: 'default'
            },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'Your match request has been accepted!' },
        }

        dbNotificationBody = {
            userID: matchedUserIdAfter,
            message: matchedUserData.matchedUserID === snapshot.after.id ?  
               `Your match request has been accepted by ${userDataAfter.username}! Go and chat!` 
               : `You've received a new match request from ${userDataAfter.username}! Check it out!`,
            sentTime: sentTime
        };
    } else {
        // clear teacher/student
        matchedUserData = await getUserDataById(matchedUserIdBefore);

        if(matchedUserData === null) {
            // if the data in the received doc is null
            // or if the matchedUser is unmatched (doesn't care whether he's being unmatched)
            // may implement notification about losing a potential match in the future
            return; // error handled by getUserData function; no need to log it
        }

        payload = matchedUserData.matchedUserID === null ? {
            notification: { 
                title: 'Uh-oh! You lost`' + userDataAfter.username + ' as a potential pair!', 
                body: userDataAfter.username + ' has decided to cancel their match request to you! Don\'t forget about your potential pairs!', 
                sound: 'default' 
            },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'You\'ve been unmatched or skipped! Find a new pair!' },
        } : { // payload to send as a notification in the specific format required; doesn't matter which user data is accessed here
            notification: { title: 'Uh-oh! Looks like ' + userDataAfter.username + ' has unmatched you!', 
                body: userDataAfter.username + ' has decided to remove you as a pair! You can clear your match as well and find someone new!', 
                sound: 'default' 
            },
            data: { click_action: 'FLUTTER_NOTIFICATION_CLICK', message: 'You\'ve been unmatched or skipped! Find a new pair!' },
        }

        dbNotificationBody = {
            userID: matchedUserIdBefore,
            message: matchedUserData.matchedUserID === null ? 
                `You lost ${userDataAfter.username} as a potential pair! Find a new one!`
                : `You've been unmatched by ${userDataAfter.username}! Find a new pair!`,
            sentTime: sentTime
        };
    }

    var notificationAddResult = await admin.firestore().collection('notifications').add(
        dbNotificationBody // add the db notification body as an object here
    ); // send it to the db even if the user is logged out (passed all relevant checks)

    matchedUserDeviceTokens = matchedUserData.deviceTokens; // get the user's original device tokens where he's logged in

    if(matchedUserDeviceTokens.length === 0) {
        // null/empty array (user logged out from all devices); return
        console.error('No registered device tokens (user is logged out from all devices). Cancelling notification!');
        return;
    }

    var tokenMergeResult = await sendValidTokens(
        isMatchRequest ? matchedUserIdAfter : matchedUserIdBefore, // send notification either to cancelled or matched user
        matchedUserDeviceTokens, 
        payload
    ); // send push notification to matched user
});

// TODO: Implement skipped user push notification for user who sent the match request

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//  response.send("Hello from Firebase!");
// });